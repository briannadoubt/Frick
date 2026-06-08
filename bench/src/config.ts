import { type CodecConfig } from "./codec.js";
import { type LoadHarnessConfig } from "./harness.js";
import { type LatencyConfig } from "./latency.js";
import { type ThroughputConfig } from "./throughput.js";

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

/**
 * Resolve a latency-suite config from CLI flags layered over environment
 * variables. Precedence: flag > env > default.
 *
 * Flags: `--iterations`, `--catch-up-backlog`, `--http-url`, `--ws-url`.
 * Env: `FRICK_LAT_ITERATIONS`, `FRICK_LAT_CATCH_UP_BACKLOG`,
 * `FRICK_LOAD_HTTP_URL`, `FRICK_LOAD_WS_URL` (the target env is shared with the
 * load harness).
 */
export function parseLatencyConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Partial<LatencyConfig> {
  const flags = parseFlags(argv);
  const config: {
    iterations?: number;
    catchUpBacklog?: number;
    target?: { httpUrl: string; wsUrl: string };
  } = {};

  const iterations = pickNumber(flags.iterations, env.FRICK_LAT_ITERATIONS);
  if (iterations !== undefined) config.iterations = iterations;

  const backlog = pickNumber(flags["catch-up-backlog"], env.FRICK_LAT_CATCH_UP_BACKLOG);
  if (backlog !== undefined) config.catchUpBacklog = backlog;

  const target = pickTarget(flags, env);
  if (target) config.target = target;

  return config;
}

/**
 * Resolve a throughput-suite config from CLI flags layered over environment
 * variables. Precedence: flag > env > default.
 *
 * Flags: `--connections`, `--ops-per-connection`, `--upsert-ratio`,
 * `--no-await-acks`, `--seed`, `--http-url`, `--ws-url`.
 * Env: `FRICK_TPUT_CONNECTIONS`, `FRICK_TPUT_OPS_PER_CONNECTION`,
 * `FRICK_TPUT_UPSERT_RATIO`, `FRICK_TPUT_AWAIT_ACKS`, `FRICK_LOAD_SEED`,
 * `FRICK_LOAD_HTTP_URL`, `FRICK_LOAD_WS_URL`.
 */
export function parseThroughputConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Partial<ThroughputConfig> {
  const flags = parseFlags(argv);
  const config: {
    connections?: number;
    opsPerConnection?: number;
    upsertRatio?: number;
    awaitAcks?: boolean;
    seed?: number;
    target?: { httpUrl: string; wsUrl: string };
  } = {};

  const connections = pickNumber(flags.connections, env.FRICK_TPUT_CONNECTIONS);
  if (connections !== undefined) config.connections = connections;

  const opsPerConnection = pickNumber(
    flags["ops-per-connection"],
    env.FRICK_TPUT_OPS_PER_CONNECTION,
  );
  if (opsPerConnection !== undefined) config.opsPerConnection = opsPerConnection;

  const upsertRatio = pickNumber(flags["upsert-ratio"], env.FRICK_TPUT_UPSERT_RATIO);
  if (upsertRatio !== undefined) {
    if (upsertRatio > 1) {
      throw new Error(`--upsert-ratio must be between 0 and 1: ${upsertRatio}`);
    }
    config.upsertRatio = upsertRatio;
  }

  const awaitAcks = pickAwaitAcks(flags, env.FRICK_TPUT_AWAIT_ACKS);
  if (awaitAcks !== undefined) config.awaitAcks = awaitAcks;

  const seed = pickNumber(flags.seed, env.FRICK_LOAD_SEED);
  if (seed !== undefined) config.seed = seed;

  const target = pickTarget(flags, env);
  if (target) config.target = target;

  return config;
}

/**
 * Resolve a codec-suite config from CLI flags layered over environment
 * variables. Precedence: flag > env > default. The codec suite is pure CPU
 * work (no server), so it has no `--http-url`/`--ws-url` target.
 *
 * Flags: `--ops`, `--samples`, `--page-events`.
 * Env: `FRICK_CODEC_OPS`, `FRICK_CODEC_SAMPLES`, `FRICK_CODEC_PAGE_EVENTS`.
 */
export function parseCodecConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Partial<CodecConfig> {
  const flags = parseFlags(argv);
  const config: { ops?: number; samples?: number; pageEvents?: number } = {};

  const ops = pickNumber(flags.ops, env.FRICK_CODEC_OPS);
  if (ops !== undefined) config.ops = ops;

  const samples = pickNumber(flags.samples, env.FRICK_CODEC_SAMPLES);
  if (samples !== undefined) config.samples = samples;

  const pageEvents = pickNumber(flags["page-events"], env.FRICK_CODEC_PAGE_EVENTS);
  if (pageEvents !== undefined) config.pageEvents = pageEvents;

  return config;
}

/** Shared `--http-url` / `--ws-url` extraction (both required together). */
function pickTarget(
  flags: ParsedFlags,
  env: NodeJS.ProcessEnv,
): { httpUrl: string; wsUrl: string } | undefined {
  const httpUrl = pickString(flags["http-url"], env.FRICK_LOAD_HTTP_URL);
  const wsUrl = pickString(flags["ws-url"], env.FRICK_LOAD_WS_URL);
  if (httpUrl && wsUrl) return { httpUrl, wsUrl };
  if (httpUrl || wsUrl) {
    throw new Error("both --http-url and --ws-url must be set to target an external server");
  }
  return undefined;
}

function pickAwaitAcks(flags: ParsedFlags, envValue: string | undefined): boolean | undefined {
  if (flags["no-await-acks"] === true || flags["await-acks"] === "false") return false;
  if (flags["await-acks"] === true || flags["await-acks"] === "true") return true;
  if (envValue !== undefined) {
    if (envValue === "0" || envValue.toLowerCase() === "false") return false;
    if (envValue === "1" || envValue.toLowerCase() === "true") return true;
  }
  return undefined;
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
