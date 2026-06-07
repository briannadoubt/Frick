import { type LoadHarnessConfig } from "./harness.js";

/**
 * Resolve a load config from CLI flags layered over environment variables
 * layered over {@link DEFAULT_LOAD_CONFIG}. Precedence: flag > env > default.
 *
 * Flags: `--users`, `--appends-per-user`, `--object-writes-per-user`,
 * `--seed`, `--no-subscribe`, `--http-url`, `--ws-url`.
 * Env: `FRICK_LOAD_USERS`, `FRICK_LOAD_APPENDS_PER_USER`,
 * `FRICK_LOAD_OBJECT_WRITES_PER_USER`, `FRICK_LOAD_SEED`,
 * `FRICK_LOAD_SUBSCRIBE`, `FRICK_LOAD_HTTP_URL`, `FRICK_LOAD_WS_URL`.
 */
export function parseLoadConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Partial<LoadHarnessConfig> {
  const flags = parseFlags(argv);

  const config: {
    users?: number;
    appendsPerUser?: number;
    objectWritesPerUser?: number;
    seed?: number;
    subscribe?: boolean;
    target?: { httpUrl: string; wsUrl: string };
  } = {};

  const users = pickNumber(flags.users, env.FRICK_LOAD_USERS);
  if (users !== undefined) config.users = users;

  const appends = pickNumber(flags["appends-per-user"], env.FRICK_LOAD_APPENDS_PER_USER);
  if (appends !== undefined) config.appendsPerUser = appends;

  const objectWrites = pickNumber(
    flags["object-writes-per-user"],
    env.FRICK_LOAD_OBJECT_WRITES_PER_USER,
  );
  if (objectWrites !== undefined) config.objectWritesPerUser = objectWrites;

  const seed = pickNumber(flags.seed, env.FRICK_LOAD_SEED);
  if (seed !== undefined) config.seed = seed;

  const subscribe = pickSubscribe(flags, env.FRICK_LOAD_SUBSCRIBE);
  if (subscribe !== undefined) config.subscribe = subscribe;

  const httpUrl = pickString(flags["http-url"], env.FRICK_LOAD_HTTP_URL);
  const wsUrl = pickString(flags["ws-url"], env.FRICK_LOAD_WS_URL);
  if (httpUrl && wsUrl) {
    config.target = { httpUrl, wsUrl };
  } else if (httpUrl || wsUrl) {
    throw new Error("both --http-url and --ws-url must be set to target an external server");
  }

  return config;
}

/** Doc reference for default precedence: see {@link parseLoadConfig}. */
interface ParsedFlags {
  [key: string]: string | boolean | undefined;
}

function parseFlags(argv: readonly string[]): ParsedFlags {
  const flags: ParsedFlags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = true;
    }
  }
  return flags;
}

function pickNumber(flag: string | boolean | undefined, envValue: string | undefined): number | undefined {
  const raw = typeof flag === "string" ? flag : envValue;
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`invalid numeric value: ${raw}`);
  }
  return n;
}

function pickString(flag: string | boolean | undefined, envValue: string | undefined): string | undefined {
  if (typeof flag === "string") return flag;
  if (envValue !== undefined && envValue !== "") return envValue;
  return undefined;
}

function pickSubscribe(flags: ParsedFlags, envValue: string | undefined): boolean | undefined {
  if (flags["no-subscribe"] === true || flags.subscribe === "false") return false;
  if (flags.subscribe === true || flags.subscribe === "true") return true;
  if (envValue !== undefined) {
    if (envValue === "0" || envValue.toLowerCase() === "false") return false;
    if (envValue === "1" || envValue.toLowerCase() === "true") return true;
  }
  return undefined;
}
