import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireBoolean, requireString, type ParsedArgs } from "../argv.js";
import { CliUsageError } from "../errors.js";
import { emit, type OutputOptions } from "../output.js";

type DeployProfile = "compose" | "lightweight";

interface DeployPlan {
  ok: boolean;
  command: "deploy";
  profile: DeployProfile;
  dryRun: boolean;
  started: boolean;
  composeFiles: string[];
  env: Record<string, string>;
  services: string[];
  steps: string[];
}

const COMPOSE_BROKERS = "redpanda:9092";
const COMPOSE_OTLP_ENDPOINT = "http://otel-collector:4318";

export async function deployCommand(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const profile = parseProfile(requireString(parsed.flags, "profile") ?? "compose");
  const dryRun = requireBoolean(parsed.flags, "dry-run");
  const plan = createDeployPlan(profile, dryRun);
  if (dryRun) {
    emit(plan, out);
    return 0;
  }

  const exitCode = await runDockerCompose(plan.composeFiles, out);
  emit({ ...plan, ok: exitCode === 0, started: exitCode === 0, exitCode }, out);
  return exitCode;
}

function createDeployPlan(profile: DeployProfile, dryRun: boolean): DeployPlan {
  if (profile === "lightweight") {
    const composeFile = resolveRepoPath("ops/deploy/lightweight.compose.yaml");
    return {
      ok: true,
      command: "deploy",
      profile,
      dryRun,
      started: false,
      composeFiles: [composeFile],
      env: {
        FRICK_ENV: "production",
        FRICK_HOST: "0.0.0.0",
        FRICK_PORT: "4099",
        FRICK_DB_PATH: "/var/lib/frick/frick.sqlite",
        FRICK_PLATFORM_EVENTS_DRIVER: "sqlite",
        FRICK_OTEL_ENABLED: "false",
      },
      services: [
        "frick-server",
      ],
      steps: [
        "set FRICK_SERVER_IMAGE to a built Frick app/runtime image",
        "docker compose -f ops/deploy/lightweight.compose.yaml up -d --wait",
      ],
    };
  }

  const composeFile = resolveRepoPath("ops/deploy/compose.yaml");
  return {
    ok: true,
    command: "deploy",
    profile,
    dryRun,
    started: false,
    composeFiles: [composeFile],
    env: {
      FRICK_ENV: "production",
      FRICK_HOST: "0.0.0.0",
      FRICK_PORT: "4099",
      FRICK_DB_PATH: "/var/lib/frick/frick.sqlite",
      FRICK_PLATFORM_EVENTS_DRIVER: "kafka",
      FRICK_PLATFORM_EVENTS_KAFKA_BROKERS: COMPOSE_BROKERS,
      FRICK_PLATFORM_EVENTS_TOPIC: "frick.platform.events",
      FRICK_OTEL_ENABLED: "true",
      FRICK_OTEL_EXPORTER_OTLP_ENDPOINT: COMPOSE_OTLP_ENDPOINT,
      FRICK_OTEL_SERVICE_NAME: "frick-server",
    },
    services: [
      "frick-server",
      "redpanda",
      "otel-collector",
    ],
    steps: [
      "set FRICK_SERVER_IMAGE to a built Frick app/runtime image",
      "set FRICK_ADMIN_TOKEN to enable production dashboard/admin APIs",
      "docker compose -f ops/deploy/compose.yaml up -d --wait",
    ],
  };
}

function parseProfile(value: string): DeployProfile {
  if (value === "compose" || value === "lightweight") return value;
  throw new CliUsageError(`--profile must be one of compose, lightweight, got ${JSON.stringify(value)}`);
}

function runDockerCompose(composeFiles: readonly string[], out: OutputOptions): Promise<number> {
  const args = [
    "compose",
    ...composeFiles.flatMap((file) => ["-f", file]),
    "up",
    "-d",
    "--wait",
  ];
  return new Promise((resolveRun, reject) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
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
