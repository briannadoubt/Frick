/**
 * CLI exit codes and error mapping.
 *
 *  - 0: success
 *  - 1: a check failed (doctor red, db unreachable, schema invalid, …)
 *  - 2: argument / usage error (unknown command, missing required arg, bad flag)
 *  - 3: framework refused (e.g. `reset` outside development, prod migrate
 *       without `--confirm-prod`). Distinguished so wrapping scripts can
 *       react: prompt for confirmation, log differently, etc.
 */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 3;

export class CliUsageError extends Error {
  readonly code = "cli.usage";
  readonly exitCode = EXIT_USAGE;
  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "CliUsageError";
  }
}

export class CliRefusedError extends Error {
  readonly code = "cli.refused";
  readonly exitCode = EXIT_REFUSED;
  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "CliRefusedError";
  }
}

export class CliFailureError extends Error {
  readonly code: string;
  readonly exitCode = EXIT_FAILURE;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "CliFailureError";
  }
}

export interface CliErrorShape {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  exitCode: number;
}

export function toErrorShape(error: unknown): CliErrorShape {
  if (error instanceof CliUsageError || error instanceof CliRefusedError || error instanceof CliFailureError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      exitCode: error.exitCode,
    };
  }
  if (error instanceof Error) {
    return {
      code: error.name || "cli.error",
      message: error.message,
      exitCode: EXIT_FAILURE,
    };
  }
  return {
    code: "cli.error",
    message: String(error),
    exitCode: EXIT_FAILURE,
  };
}
