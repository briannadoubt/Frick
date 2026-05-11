/**
 * Minimal hand-rolled argv parser. The CLI surface is small enough that a
 * dependency on `yargs`/`commander` isn't justified.
 *
 * Grammar:
 *   - `--flag` → `{ flag: true }`
 *   - `--flag=value` → `{ flag: "value" }`
 *   - `--flag value` → `{ flag: "value" }` *only* if `value` does not start
 *     with `--`. Otherwise `--flag` is treated as a boolean and `value` is
 *     reparsed as the next token.
 *   - Anything not starting with `--` is a positional argument.
 *
 * The parser deliberately doesn't know about flag schemas (no list of
 * "boolean flags vs string flags"). Commands inspect the resulting record
 * and coerce types themselves.
 */
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      const key = body.slice(0, eq);
      const value = body.slice(eq + 1);
      flags[key] = value;
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = true;
    }
  }
  return { positionals, flags };
}

export function requireString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return undefined;
  return value;
}

export function requireBoolean(flags: Record<string, string | boolean>, key: string): boolean {
  const value = flags[key];
  if (value === true) return true;
  if (typeof value === "string") {
    return value !== "false" && value !== "0" && value !== "no";
  }
  return false;
}
