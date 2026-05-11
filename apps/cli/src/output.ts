/**
 * JSON-first output helpers for the `frick` CLI.
 *
 * Default output: JSON Lines (one JSON object per logical record) on stdout.
 * `--pretty` (or `--json=pretty`) switches to indented JSON on stdout.
 * Errors always go to stderr as a single JSON object.
 *
 * The CLI deliberately does not have human-only output modes — the spec
 * principle is "machine-readable first, human summaries layered on top of
 * the stable JSON shape." Pretty mode is still JSON, just indented.
 */

export type OutputMode = "json" | "pretty";

export interface OutputOptions {
  mode: OutputMode;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export function resolveOutputMode(flags: Record<string, string | boolean | undefined>): OutputMode {
  if (flags.pretty === true) return "pretty";
  const json = flags.json;
  if (typeof json === "string" && json === "pretty") return "pretty";
  return "json";
}

export function emit(record: unknown, opts: OutputOptions): void {
  const payload =
    opts.mode === "pretty" ? `${JSON.stringify(record, null, 2)}\n` : `${JSON.stringify(record)}\n`;
  opts.stdout.write(payload);
}

export function emitError(
  error: { code: string; message: string; details?: unknown },
  opts: OutputOptions,
): void {
  const body = { error };
  const payload =
    opts.mode === "pretty" ? `${JSON.stringify(body, null, 2)}\n` : `${JSON.stringify(body)}\n`;
  opts.stderr.write(payload);
}
