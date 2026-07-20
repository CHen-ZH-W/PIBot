#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <dirent.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <sched.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif

#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif

#ifndef __NR_landlock_add_rule
#define __NR_landlock_add_rule 445
#endif

#ifndef __NR_landlock_restrict_self
#define __NR_landlock_restrict_self 446
#endif

#define EXIT_SANDBOX_SETUP 125
#define RETURN_ERRNO(error) (SECCOMP_RET_ERRNO | ((error) & SECCOMP_RET_DATA))
#define DENY_ERRNO RETURN_ERRNO(EPERM)
#define REJECT_SYSCALL(number, error)                                          \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (number), 0, 1),                       \
      BPF_STMT(BPF_RET | BPF_K, RETURN_ERRNO(error))
#define DENY_SYSCALL(number) REJECT_SYSCALL(number, EPERM)

static uint64_t handled_access_fs;
static uint64_t file_access;
static uint64_t readonly_dir_access;
static uint64_t mutable_dir_access;

struct options {
  const char *workspace;
  const char *cwd;
  const char *tmp;
  rlim_t cpu_seconds;
  rlim_t max_processes;
  rlim_t max_open_files;
  rlim_t max_file_size_bytes;
  rlim_t max_memory_bytes;
  int command_index;
};

static void fail(const char *message) {
  fprintf(stderr, "pibot-linux-sandbox: %s: %s\n", message, strerror(errno));
  exit(EXIT_SANDBOX_SETUP);
}

static void fail_message(const char *message) {
  fprintf(stderr, "pibot-linux-sandbox: %s\n", message);
  exit(EXIT_SANDBOX_SETUP);
}

static long landlock_create_ruleset(const struct landlock_ruleset_attr *attr,
                                    size_t size, uint32_t flags) {
  return syscall(__NR_landlock_create_ruleset, attr, size, flags);
}

static int landlock_add_path_rule(int ruleset_fd, const char *path,
                                  uint64_t allowed_access, int required) {
  struct landlock_path_beneath_attr rule = {
      .allowed_access = allowed_access,
  };
  int path_fd = open(path, O_PATH | O_CLOEXEC);

  if (path_fd < 0) {
    if (!required && errno == ENOENT) {
      return 0;
    }
    fail(path);
  }

  rule.parent_fd = path_fd;
  if (syscall(__NR_landlock_add_rule, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH,
              &rule, 0) < 0) {
    close(path_fd);
    fail("landlock_add_rule");
  }

  close(path_fd);
  return 0;
}

static int is_protected_name(const char *name) {
  if (strcmp(name, ".git") == 0 || strcmp(name, ".pibot") == 0 ||
      strcmp(name, ".npmrc") == 0 || strcmp(name, ".netrc") == 0 ||
      strcmp(name, ".gitconfig") == 0 || strcmp(name, ".pibotignore") == 0 ||
      strcmp(name, "instructions.md") == 0 ||
      strcmp(name, "context.jsonl") == 0 || strcmp(name, "log.jsonl") == 0 ||
      strcmp(name, "MEMORY.md") == 0 || strcmp(name, "repo.json") == 0) {
    return 1;
  }

  if (strcmp(name, ".env") == 0) {
    return 1;
  }

  return strncmp(name, ".env.", 5) == 0 && strcmp(name, ".env.example") != 0;
}

static char *join_path(const char *parent, const char *name) {
  size_t parent_len = strlen(parent);
  size_t name_len = strlen(name);
  char *result = malloc(parent_len + name_len + 2);

  if (result == NULL) {
    fail("malloc");
  }

  memcpy(result, parent, parent_len);
  result[parent_len] = '/';
  memcpy(result + parent_len + 1, name, name_len + 1);
  return result;
}

/*
 * Landlock rules are additive. A directory containing a protected descendant
 * cannot receive a broad writable rule, otherwise that rule would also cover
 * the protected path. Such directories receive list access only; their clean
 * children and ordinary files receive narrower rules.
 */
static int add_workspace_tree(int ruleset_fd, const char *path) {
  DIR *directory;
  struct dirent *entry;
  int clean_subtree = 1;

  directory = opendir(path);
  if (directory == NULL) {
    fail(path);
  }

  while ((entry = readdir(directory)) != NULL) {
    struct stat entry_stat;
    char *child_path;

    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) {
      continue;
    }

    if (is_protected_name(entry->d_name)) {
      clean_subtree = 0;
      continue;
    }

    child_path = join_path(path, entry->d_name);
    if (lstat(child_path, &entry_stat) < 0) {
      free(child_path);
      closedir(directory);
      fail("lstat workspace entry");
    }

    if (S_ISDIR(entry_stat.st_mode)) {
      if (!add_workspace_tree(ruleset_fd, child_path)) {
        clean_subtree = 0;
      }
    } else if (S_ISREG(entry_stat.st_mode)) {
      landlock_add_path_rule(ruleset_fd, child_path, file_access, 1);
    } else if (!S_ISLNK(entry_stat.st_mode)) {
      clean_subtree = 0;
    }

    free(child_path);
  }

  if (closedir(directory) < 0) {
    fail("closedir");
  }

  landlock_add_path_rule(ruleset_fd, path,
                         clean_subtree ? mutable_dir_access
                                       : LANDLOCK_ACCESS_FS_READ_DIR,
                         1);
  return clean_subtree;
}

static void add_runtime_rules(int ruleset_fd) {
  static const char *const readonly_directories[] = {
      "/bin",          "/sbin",          "/lib",       "/lib64",
      "/usr/bin",      "/usr/sbin",      "/usr/lib",   "/usr/lib64",
      "/usr/include",  "/usr/local/bin",  "/usr/local/sbin",
      "/usr/local/lib", "/usr/local/lib64", "/usr/local/include",
  };
  static const char *const readonly_files[] = {
      "/etc/ld.so.cache",
      "/etc/localtime",
      "/etc/ssl/openssl.cnf",
  };
  static const char *const device_files[] = {
      "/dev/null",
      "/dev/zero",
      "/dev/random",
      "/dev/urandom",
  };
  size_t index;

  for (index = 0;
       index < sizeof(readonly_directories) / sizeof(readonly_directories[0]);
       index++) {
    landlock_add_path_rule(ruleset_fd, readonly_directories[index],
                           readonly_dir_access, 0);
  }

  for (index = 0; index < sizeof(readonly_files) / sizeof(readonly_files[0]);
       index++) {
    landlock_add_path_rule(ruleset_fd, readonly_files[index],
                           LANDLOCK_ACCESS_FS_READ_FILE, 0);
  }

  for (index = 0; index < sizeof(device_files) / sizeof(device_files[0]);
       index++) {
    landlock_add_path_rule(ruleset_fd, device_files[index],
                           LANDLOCK_ACCESS_FS_READ_FILE |
                               LANDLOCK_ACCESS_FS_WRITE_FILE,
                           0);
  }
}

static void install_landlock(const char *workspace, const char *tmp) {
  struct landlock_ruleset_attr attr = {0};
  int abi;
  int ruleset_fd;

  abi = (int)landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 0) {
    fail("Landlock is unavailable");
  }

  if (abi < 3) {
    fail_message("Landlock ABI 3 or newer is required");
  }

  handled_access_fs =
      LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE |
      LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR |
      LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
      LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |
      LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK |
      LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK |
      LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER |
      LANDLOCK_ACCESS_FS_TRUNCATE;
  file_access = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE |
                LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_TRUNCATE;
  readonly_dir_access = LANDLOCK_ACCESS_FS_EXECUTE |
                        LANDLOCK_ACCESS_FS_READ_FILE |
                        LANDLOCK_ACCESS_FS_READ_DIR;
  mutable_dir_access =
      file_access | LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_REMOVE_DIR |
      LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_DIR |
      LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SYM |
      LANDLOCK_ACCESS_FS_REFER;

  attr.handled_access_fs = handled_access_fs;
  ruleset_fd = (int)landlock_create_ruleset(&attr, sizeof(attr), 0);
  if (ruleset_fd < 0) {
    fail("landlock_create_ruleset");
  }

  add_runtime_rules(ruleset_fd);
  add_workspace_tree(ruleset_fd, workspace);
  landlock_add_path_rule(ruleset_fd, tmp, mutable_dir_access, 1);

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) {
    close(ruleset_fd);
    fail("PR_SET_NO_NEW_PRIVS");
  }

  if (syscall(__NR_landlock_restrict_self, ruleset_fd, 0) < 0) {
    close(ruleset_fd);
    fail("landlock_restrict_self");
  }

  close(ruleset_fd);
}

static void install_seccomp(void) {
#if defined(__x86_64__)
#define PIBOT_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define PIBOT_AUDIT_ARCH AUDIT_ARCH_AARCH64
#else
#error "pibot-linux-sandbox supports x86_64 and aarch64 only"
#endif

  static const struct sock_filter filter[] = {
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
               offsetof(struct seccomp_data, arch)),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, PIBOT_AUDIT_ARCH, 1, 0),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#ifdef __NR_socket
      DENY_SYSCALL(__NR_socket),
#endif
#ifdef __NR_connect
      DENY_SYSCALL(__NR_connect),
#endif
#ifdef __NR_bind
      DENY_SYSCALL(__NR_bind),
#endif
#ifdef __NR_listen
      DENY_SYSCALL(__NR_listen),
#endif
#ifdef __NR_accept
      DENY_SYSCALL(__NR_accept),
#endif
#ifdef __NR_accept4
      DENY_SYSCALL(__NR_accept4),
#endif
#ifdef __NR_sendto
      DENY_SYSCALL(__NR_sendto),
#endif
#ifdef __NR_sendmsg
      DENY_SYSCALL(__NR_sendmsg),
#endif
#ifdef __NR_sendmmsg
      DENY_SYSCALL(__NR_sendmmsg),
#endif
#ifdef __NR_recvmsg
      DENY_SYSCALL(__NR_recvmsg),
#endif
#ifdef __NR_recvmmsg
      DENY_SYSCALL(__NR_recvmmsg),
#endif
#ifdef __NR_mount
      DENY_SYSCALL(__NR_mount),
#endif
#ifdef __NR_umount2
      DENY_SYSCALL(__NR_umount2),
#endif
#ifdef __NR_pivot_root
      DENY_SYSCALL(__NR_pivot_root),
#endif
#ifdef __NR_chroot
      DENY_SYSCALL(__NR_chroot),
#endif
#ifdef __NR_setns
      DENY_SYSCALL(__NR_setns),
#endif
#ifdef __NR_unshare
      DENY_SYSCALL(__NR_unshare),
#endif
#ifdef __NR_ptrace
      DENY_SYSCALL(__NR_ptrace),
#endif
#ifdef __NR_process_vm_readv
      DENY_SYSCALL(__NR_process_vm_readv),
#endif
#ifdef __NR_process_vm_writev
      DENY_SYSCALL(__NR_process_vm_writev),
#endif
#ifdef __NR_bpf
      DENY_SYSCALL(__NR_bpf),
#endif
#ifdef __NR_perf_event_open
      DENY_SYSCALL(__NR_perf_event_open),
#endif
#ifdef __NR_userfaultfd
      DENY_SYSCALL(__NR_userfaultfd),
#endif
#ifdef __NR_open_by_handle_at
      DENY_SYSCALL(__NR_open_by_handle_at),
#endif
#ifdef __NR_name_to_handle_at
      DENY_SYSCALL(__NR_name_to_handle_at),
#endif
#ifdef __NR_init_module
      DENY_SYSCALL(__NR_init_module),
#endif
#ifdef __NR_finit_module
      DENY_SYSCALL(__NR_finit_module),
#endif
#ifdef __NR_delete_module
      DENY_SYSCALL(__NR_delete_module),
#endif
#ifdef __NR_keyctl
      DENY_SYSCALL(__NR_keyctl),
#endif
#ifdef __NR_add_key
      DENY_SYSCALL(__NR_add_key),
#endif
#ifdef __NR_request_key
      DENY_SYSCALL(__NR_request_key),
#endif
#ifdef __NR_reboot
      DENY_SYSCALL(__NR_reboot),
#endif
#ifdef __NR_kexec_load
      DENY_SYSCALL(__NR_kexec_load),
#endif
#ifdef __NR_kexec_file_load
      DENY_SYSCALL(__NR_kexec_file_load),
#endif
#ifdef __NR_swapon
      DENY_SYSCALL(__NR_swapon),
#endif
#ifdef __NR_swapoff
      DENY_SYSCALL(__NR_swapoff),
#endif
#ifdef __NR_mknod
      DENY_SYSCALL(__NR_mknod),
#endif
#ifdef __NR_mknodat
      DENY_SYSCALL(__NR_mknodat),
#endif
#ifdef __NR_chown
      DENY_SYSCALL(__NR_chown),
#endif
#ifdef __NR_fchown
      DENY_SYSCALL(__NR_fchown),
#endif
#ifdef __NR_lchown
      DENY_SYSCALL(__NR_lchown),
#endif
#ifdef __NR_fchownat
      DENY_SYSCALL(__NR_fchownat),
#endif
#ifdef __NR_setxattr
      DENY_SYSCALL(__NR_setxattr),
#endif
#ifdef __NR_lsetxattr
      DENY_SYSCALL(__NR_lsetxattr),
#endif
#ifdef __NR_fsetxattr
      DENY_SYSCALL(__NR_fsetxattr),
#endif
#ifdef __NR_removexattr
      DENY_SYSCALL(__NR_removexattr),
#endif
#ifdef __NR_lremovexattr
      DENY_SYSCALL(__NR_lremovexattr),
#endif
#ifdef __NR_fremovexattr
      DENY_SYSCALL(__NR_fremovexattr),
#endif
#ifdef __NR_utime
      DENY_SYSCALL(__NR_utime),
#endif
#ifdef __NR_utimes
      DENY_SYSCALL(__NR_utimes),
#endif
#ifdef __NR_futimesat
      DENY_SYSCALL(__NR_futimesat),
#endif
#ifdef __NR_utimensat
      DENY_SYSCALL(__NR_utimensat),
#endif
#ifdef __NR_clone3
      REJECT_SYSCALL(__NR_clone3, ENOSYS),
#endif
#ifdef __NR_clone
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 3),
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
               offsetof(struct seccomp_data, args[0])),
      BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K,
               CLONE_NEWCGROUP | CLONE_NEWIPC | CLONE_NEWNET | CLONE_NEWNS |
                   CLONE_NEWPID | CLONE_NEWUSER | CLONE_NEWUTS,
               0, 1),
      BPF_STMT(BPF_RET | BPF_K, DENY_ERRNO),
#endif
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  static const struct sock_fprog program = {
      .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
      .filter = (struct sock_filter *)filter,
  };

  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) < 0) {
    fail("PR_SET_SECCOMP");
  }
}

static void set_limit(int resource, rlim_t value, const char *name) {
  struct rlimit existing;
  struct rlimit limit = {
      .rlim_cur = value,
      .rlim_max = value,
  };

  if (getrlimit(resource, &existing) < 0) {
    fail(name);
  }

  if (existing.rlim_max != RLIM_INFINITY && existing.rlim_max < value) {
    limit.rlim_cur = existing.rlim_max;
    limit.rlim_max = existing.rlim_max;
  }

  if (setrlimit(resource, &limit) < 0) {
    fail(name);
  }
}

static rlim_t parse_limit(const char *value, const char *name) {
  char *end = NULL;
  unsigned long long parsed;

  errno = 0;
  parsed = strtoull(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed == 0) {
    fail_message(name);
  }

  return (rlim_t)parsed;
}

static void parse_options(int argc, char **argv, struct options *options) {
  int index;

  memset(options, 0, sizeof(*options));
  for (index = 1; index < argc; index++) {
    if (strcmp(argv[index], "--") == 0) {
      options->command_index = index + 1;
      break;
    }

    if (index + 1 >= argc) {
      fail_message("missing option value");
    }

    if (strcmp(argv[index], "--workspace") == 0) {
      options->workspace = argv[++index];
    } else if (strcmp(argv[index], "--cwd") == 0) {
      options->cwd = argv[++index];
    } else if (strcmp(argv[index], "--tmp") == 0) {
      options->tmp = argv[++index];
    } else if (strcmp(argv[index], "--cpu-seconds") == 0) {
      options->cpu_seconds = parse_limit(argv[++index], "invalid cpu limit");
    } else if (strcmp(argv[index], "--max-processes") == 0) {
      options->max_processes =
          parse_limit(argv[++index], "invalid process limit");
    } else if (strcmp(argv[index], "--max-open-files") == 0) {
      options->max_open_files =
          parse_limit(argv[++index], "invalid open file limit");
    } else if (strcmp(argv[index], "--max-file-size-bytes") == 0) {
      options->max_file_size_bytes =
          parse_limit(argv[++index], "invalid file size limit");
    } else if (strcmp(argv[index], "--max-memory-bytes") == 0) {
      options->max_memory_bytes =
          parse_limit(argv[++index], "invalid memory limit");
    } else {
      fail_message("unknown option");
    }
  }

  if (options->workspace == NULL || options->cwd == NULL ||
      options->tmp == NULL || options->cpu_seconds == 0 ||
      options->max_processes == 0 || options->max_open_files == 0 ||
      options->max_file_size_bytes == 0 || options->max_memory_bytes == 0 ||
      options->command_index == 0 || options->command_index >= argc) {
    fail_message("missing required options or command");
  }
}

static int is_inside(const char *root, const char *path) {
  size_t root_len = strlen(root);

  if (strcmp(root, path) == 0) {
    return 1;
  }

  if (strcmp(root, "/") == 0) {
    return path[0] == '/';
  }

  return strncmp(root, path, root_len) == 0 && path[root_len] == '/';
}

static void resolve_and_validate_paths(struct options *options,
                                       char workspace[PATH_MAX],
                                       char cwd[PATH_MAX], char tmp[PATH_MAX]) {
  if (realpath(options->workspace, workspace) == NULL) {
    fail("workspace realpath");
  }

  if (realpath(options->cwd, cwd) == NULL) {
    fail("cwd realpath");
  }

  if (realpath(options->tmp, tmp) == NULL) {
    fail("tmp realpath");
  }

  if (!is_inside(workspace, cwd)) {
    fail_message("cwd is outside workspace");
  }
}

static void clean_environment(const char *tmp) {
  if (clearenv() < 0) {
    fail("clearenv");
  }

  if (setenv("PATH", "/usr/local/bin:/usr/bin:/bin", 1) < 0 ||
      setenv("HOME", tmp, 1) < 0 || setenv("TMPDIR", tmp, 1) < 0 ||
      setenv("NPM_CONFIG_CACHE", tmp, 1) < 0 || setenv("LANG", "C.UTF-8", 1) < 0 ||
      setenv("LC_ALL", "C.UTF-8", 1) < 0) {
    fail("setenv");
  }
}

static void close_extra_fds(rlim_t max_open_files) {
  int fd;

#ifdef __NR_close_range
  if (syscall(__NR_close_range, 3U, ~0U, 0U) == 0) {
    return;
  }

  if (errno != ENOSYS) {
    fail("close_range");
  }
#endif

  for (fd = 3; fd < (int)max_open_files; fd++) {
    close(fd);
  }
}

int main(int argc, char **argv) {
  struct options options;
  char workspace[PATH_MAX];
  char cwd[PATH_MAX];
  char tmp[PATH_MAX];

  parse_options(argc, argv, &options);
  resolve_and_validate_paths(&options, workspace, cwd, tmp);

  set_limit(RLIMIT_CORE, 0, "setrlimit core");
  set_limit(RLIMIT_CPU, options.cpu_seconds, "setrlimit cpu");
  set_limit(RLIMIT_FSIZE, options.max_file_size_bytes, "setrlimit file size");
  set_limit(RLIMIT_NOFILE, options.max_open_files, "setrlimit open files");
  set_limit(RLIMIT_NPROC, options.max_processes, "setrlimit processes");
  set_limit(RLIMIT_AS, options.max_memory_bytes, "setrlimit memory");

  install_landlock(workspace, tmp);
  clean_environment(tmp);
  close_extra_fds(options.max_open_files);

  if (chdir(cwd) < 0) {
    fail("chdir");
  }

  install_seccomp();
  execvp(argv[options.command_index], &argv[options.command_index]);
  fail("execvp");
}
