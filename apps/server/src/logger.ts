/**
 * Tiny, opinionated structured logger for the Frick server.
 *
 * JSON-line output (one event per line, level-tagged). Fields that match
 * `REDACTED_FIELDS` are replaced with `"<redacted>"` so common secret-shaped
 * values can't accidentally end up in stdout. The redaction list is
 * intentionally small — it's a defense-in-depth check, not a substitute for
 * not passing secrets to the logger in the first place.
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

const REDACTED_FIELDS: ReadonlySet<string> = new Set([
  "sessionToken",
  "password",
  "passwordHash",
  "Authorization",
  "authorization",
]);

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
      for (const [key, value] of Object.entries(merged)) {
        record[key] = REDACTED_FIELDS.has(key) ? "<redacted>" : value;
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
