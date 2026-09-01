export type RecoveryDisposition =
  | "retry-safe"
  | "resumable"
  | "needs-reconciliation"
  | "terminal-failed";

const dispositionPriority: Readonly<Record<RecoveryDisposition, number>> = {
  "retry-safe": 0,
  resumable: 1,
  "terminal-failed": 2,
  "needs-reconciliation": 3,
};

export function combineRecoveryDispositions(
  dispositions: readonly RecoveryDisposition[],
  fallback: RecoveryDisposition = "retry-safe",
): RecoveryDisposition {
  return dispositions.reduce(
    (current, candidate) =>
      dispositionPriority[candidate] > dispositionPriority[current]
        ? candidate
        : current,
    fallback,
  );
}

export function isRecoveryDisposition(
  value: unknown,
): value is RecoveryDisposition {
  return value === "retry-safe" ||
    value === "resumable" ||
    value === "needs-reconciliation" ||
    value === "terminal-failed";
}
