import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireBoolean, requireString, type ParsedArgs } from "../argv.js";
import { CliUsageError } from "../errors.js";
import { emit, type OutputOptions } from "../output.js";

type DevProfile = "sqlite" | "redpanda";

interface DevPlan {
  ok: boolean;
  command: "dev";
  profile: DevProfile;
  started: boolean;
  composeFile?: string;
  env: Record<string, string>;
  steps: string[];
}

const DEFAULT_BROKERS = "127.0.0.1:19092";
const DEFAULT_OTLP_ENDPOINT = "http://127.0.0.1:4318";

export async function devCommand(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const profile = parseProfile(requireString(parsed.flags, "profile") ?? "sqlite");
  const dryRun = requireBoolean(parsed.flags, "dry-run");
  const plan = createDevPlan(profile);
  if (dryRun || profile === "sqlite") {
    emit({ ...plan, started: false }, out);
    return 0;
  }

  const exitCode = await runDockerCompose(plan.composeFile!, out);
  emit({ ...plan, ok: exitCode === 0, started: exitCode === 0, exitCode }, out);
  return exitCode;
}

function createDevPlan(profile: DevProfile): DevPlan {
  if (profile === "sqlite") {
    return {
      ok: true,
      command: "dev",
      profile,
      started: false,
      env: {
        FRICK_PLATFORM_EVENTS_DRIVER: "sqlite",
      },
      steps: [
        "pnpm server",
        "pnpm web",
        "pnpm cli dashboard",
      ],
    };
  }

  const composeFile = resolveRepoPath("ops/local/redpanda.compose.yaml");
  return {
    ok: true,
    command: "dev",
    profile,
    started: false,
    composeFile,
    env: {
      FRICK_PLATFORM_EVENTS_DRIVER: "kafka",
      FRICK_PLATFORM_EVENTS_KAFKA_BROKERS: DEFAULT_BROKERS,
      FRICK_PLATFORM_EVENTS_TOPIC: "frick.platform.events",
      FRICK_OTEL_ENABLED: "true",
      FRICK_OTEL_EXPORTER_OTLP_ENDPOINT: DEFAULT_OTLP_ENDPOINT,
      FRICK_OTEL_SERVICE_NAME: "frick-server",
      FRICK_TEST_KAFKA_BROKERS: DEFAULT_BROKERS,
    },
    steps: [
      "docker compose up -d --wait redpanda otel-collector",
      `FRICK_PLATFORM_EVENTS_KAFKA_BROKERS=${DEFAULT_BROKERS} FRICK_OTEL_ENABLED=true FRICK_OTEL_EXPORTER_OTLP_ENDPOINT=${DEFAULT_OTLP_ENDPOINT} pnpm server`,
      "pnpm web",
      "pnpm cli dashboard",
      `FRICK_TEST_KAFKA_BROKERS=${DEFAULT_BROKERS} pnpm --filter @frick/server exec vitest run tests/platform-events-kafka.test.ts`,
    ],
  };
}

function parseProfile(value: string): DevProfile {
  if (value === "sqlite" || value === "redpanda") return value;
  throw new CliUsageError(`--profile must be one of sqlite, redpanda, got ${JSON.stringify(value)}`);
}

function runDockerCompose(composeFile: string, out: OutputOptions): Promise<number> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      "docker",
      ["compose", "-f", composeFile, "up", "-d", "--wait", "redpanda", "otel-collector"],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    child.stderr.on("data", (chunk: Buffer) => out.stderr.write(chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolveRun(code ?? 1));
  });
}

function resolveRepoPath(path: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../../../..");
  return resolve(repoRoot, path);
}
