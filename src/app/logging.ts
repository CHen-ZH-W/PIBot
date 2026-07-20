export type LogPrimitive = string | number | boolean | null;
export type LogValue = LogPrimitive | readonly LogPrimitive[];
export type LogFields = Readonly<Record<string, LogValue | undefined>>;

export interface AppLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export class ConsoleJsonLogger implements AppLogger {
  info(event: string, fields: LogFields = {}): void {
    this.write("info", event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.write("warn", event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.write("error", event, fields);
  }

  private write(level: string, event: string, fields: LogFields): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...withoutUndefined(fields),
    });

    if (level === "error") {
      console.error(line);
      return;
    }

    if (level === "warn") {
      console.warn(line);
      return;
    }

    console.info(line);
  }
}

export class NoopLogger implements AppLogger {
  info(): void {}
  warn(): void {}
  error(): void {}
}

export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
    };
  }

  return {
    errorMessage: String(error),
  };
}

function withoutUndefined(fields: LogFields): Record<string, LogValue> {
  const result: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
}
