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

interface ImageBuildPlan {
  ok: boolean;
  command: "deploy";
  action: "image";
  dryRun: boolean;
  built: boolean;
  pushed: boolean;
  push: boolean;
  tag: string;
  dockerfile: string;
  context: string;
  steps: string[];
}

const COMPOSE_BROKERS = "redpanda:9092";
const COMPOSE_OTLP_ENDPOINT = "http://otel-collector:4318";
const DEFAULT_SERVER_IMAGE = "frick-server:latest";

export async function deployCommand(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const action = parsed.positionals[0];
  if (action === "image") {
    if (parsed.positionals.length > 1) {
      throw new CliUsageError("deploy image does not accept extra positional arguments");
    }
    return await deployImageCommand(parsed, out);
  }
  if (action !== undefined) {
    throw new CliUsageError(`Unknown deploy action: ${action}`);
  }

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

async function deployImageCommand(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const dryRun = requireBoolean(parsed.flags, "dry-run");
  const plan = createImageBuildPlan({
    tag: optionalStringFlag(parsed, "tag") ?? DEFAULT_SERVER_IMAGE,
    dockerfile: optionalStringFlag(parsed, "dockerfile"),
    context: optionalStringFlag(parsed, "context"),
    push: requireBoolean(parsed.flags, "push"),
    dryRun,
  });
  if (dryRun) {
    emit(plan, out);
    return 0;
  }

  const buildExitCode = await runDockerBuild(plan, out);
  if (buildExitCode !== 0 || !plan.push) {
    emit({ ...plan, ok: buildExitCode === 0, built: buildExitCode === 0, exitCode: buildExitCode }, out);
    return buildExitCode;
  }

  const pushExitCode = await runDockerPush(plan.tag, out);
  emit({
    ...plan,
    ok: pushExitCode === 0,
    built: true,
    pushed: pushExitCode === 0,
    exitCode: pushExitCode,
  }, out);
  return pushExitCode;
}

function createImageBuildPlan(input: {
  tag: string;
  dockerfile: string | undefined;
  context: string | undefined;
  push: boolean;
  dryRun: boolean;
}): ImageBuildPlan {
  const tag = validateImageTag(input.tag);
  const dockerfile =
    input.dockerfile === undefined
      ? resolveRepoPath("ops/deploy/server.Dockerfile")
      : resolveInputPath(input.dockerfile);
  const context =
    input.context === undefined
      ? resolveRepoPath(".")
      : resolveInputPath(input.context);
  return {
    ok: true,
    command: "deploy",
    action: "image",
    dryRun: input.dryRun,
    built: false,
    pushed: false,
    push: input.push,
    tag,
    dockerfile,
    context,
    steps: [
      `docker build -f ${relativeRepoPath(dockerfile)} -t ${tag} ${relativeRepoPath(context)}`,
      ...(input.push ? [`docker push ${tag}`] : []),
      `FRICK_SERVER_IMAGE=${tag} frick deploy --profile compose`,
    ],
  };
}

function runDockerPush(tag: string, out: OutputOptions): Promise<number> {
  return new Promise((resolveRun, reject) => {
    const child = spawn("docker", ["push", tag], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (chunk: Buffer) => out.stderr.write(chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolveRun(code ?? 1));
  });
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

function validateImageTag(value: string): string {
  const tag = value.trim();
  if (tag.length === 0) {
    throw new CliUsageError("--tag must not be empty");
  }
  return tag;
}

function optionalStringFlag(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.flags[key];
  if (value === undefined) return undefined;
  if (typeof value === "boolean") {
    throw new CliUsageError(`--${key} requires a value`);
  }
  if (value.trim().length === 0) {
    throw new CliUsageError(`--${key} must not be empty`);
  }
  return value;
}

function parseProfile(value: string): DeployProfile {
  if (value === "compose" || value === "lightweight") return value;
  throw new CliUsageError(`--profile must be one of compose, lightweight, got ${JSON.stringify(value)}`);
}

function runDockerBuild(plan: ImageBuildPlan, out: OutputOptions): Promise<number> {
  return new Promise((resolveRun, reject) => {
    const child = spawn("docker", ["build", "-f", plan.dockerfile, "-t", plan.tag, plan.context], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (chunk: Buffer) => out.stderr.write(chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolveRun(code ?? 1));
  });
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

function resolveInputPath(path: string): string {
  return resolve(process.cwd(), path);
}

function resolveRepoPath(path: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../../../..");
  return resolve(repoRoot, path);
}

function relativeRepoPath(path: string): string {
  const repoRoot = resolveRepoPath(".");
  const relative = path.startsWith(repoRoot) ? path.slice(repoRoot.length).replace(/^\/+/, "") : path;
  return relative.length === 0 ? "." : relative;
}
