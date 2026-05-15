/**
 * Tiny, opinionated structured logger for the Frick server.
 *
 * JSON-line output (one event per line, level-tagged). Fields with
 * secret-shaped names are replaced with `"<redacted>"` recursively so common
 * credential values can't accidentally end up in stdout. Redaction is a
 * defense-in-depth check, not a substitute for keeping secrets out of log
 * fields in the first place.
 */

import type { FrickConfig, FrickLogLevel } from "./config.js";

export interface FrickLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /**
   * Return a logger that includes `fields` in every emission. Cascades:
   * a child of a child carries both ancestors' fields. Per-emission fields
   * override inherited fields with the same name. Redaction applies to the
   * merged field set.
   */
  child(fields: Record<string, unknown>): FrickLogger;
}

const LEVEL_PRIORITY: Record<FrickLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const REDACTED_VALUE = "<redacted>";
const SENSITIVE_FIELD_PATTERN = /(?:authorization|password|secret|token|api[-_]?key|private[-_]?key)/i;

function redactField(key: string, value: unknown, seen: WeakSet<object>): unknown {
  if (SENSITIVE_FIELD_PATTERN.test(key)) {
    return REDACTED_VALUE;
  }
  return redactValue(value, seen);
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (value instanceof Date) {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const redacted = value.map((item) => redactValue(item, seen));
    seen.delete(value);
    return redacted;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    redacted[key] = redactField(key, nestedValue, seen);
  }
  seen.delete(value);
  return redacted;
}

export interface ConsoleLoggerOptions {
  /** Override the output sinks (mostly for tests). Defaults to process std streams. */
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export function createConsoleLogger(
  config: Pick<FrickConfig, "logLevel">,
  options: ConsoleLoggerOptions = {},
): FrickLogger {
  const threshold = LEVEL_PRIORITY[config.logLevel];
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = options.err ?? ((line: string) => process.stderr.write(`${line}\n`));

  function build(inherited: Record<string, unknown>): FrickLogger {
    function emit(level: FrickLogLevel, message: string, fields?: Record<string, unknown>): void {
      if (LEVEL_PRIORITY[level] < threshold) return;
      const record: Record<string, unknown> = {
        ts: new Date().toISOString(),
        level,
        msg: message,
      };
      const merged: Record<string, unknown> = { ...inherited, ...(fields ?? {}) };
      const seen = new WeakSet<object>();
      for (const [key, value] of Object.entries(merged)) {
        record[key] = redactField(key, value, seen);
      }
      const line = JSON.stringify(record);
      if (level === "error" || level === "warn") {
        err(line);
      } else {
        out(line);
      }
    }

    return {
      debug: (message, fields) => emit("debug", message, fields),
      info: (message, fields) => emit("info", message, fields),
      warn: (message, fields) => emit("warn", message, fields),
      error: (message, fields) => emit("error", message, fields),
      child: (childFields) => build({ ...inherited, ...childFields }),
    };
  }

  return build({});
}

/** Logger that discards every event. Useful in tests where output is noise. */
export function createNoopLogger(): FrickLogger {
  const logger: FrickLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return logger;
}
