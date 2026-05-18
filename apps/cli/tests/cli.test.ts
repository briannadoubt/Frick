/**
 * CLI black-box tests. Each test spawns the CLI via `tsx` against a tmpdir
 * SQLite database, captures stdout/stderr, and asserts the JSON shape.
 *
 * Spawning a real process (rather than calling `run()` in-process) is what
 * gives confidence that argv parsing, exit codes, and the stdout/stderr
 * stream split all behave as a downstream automation script would see them.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

// Locate the CLI source relative to this test file. `tsx` runs the TS source
// directly, no build step needed.
const CLI_ENTRY = new URL("../src/index.ts", import.meta.url).pathname;

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], opts: { env?: Record<string, string> } = {}): Promise<CliResult> {
  const env = { ...process.env, ...(opts.env ?? {}) };
  try {
    const { stdout, stderr } = await execFileAsync("pnpm", ["exec", "tsx", CLI_ENTRY, ...args], {
      env,
      cwd: new URL("../../..", import.meta.url).pathname,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function spawnCli(args: string[], opts: { env?: Record<string, string> } = {}): ChildProcessWithoutNullStreams {
  const env = { ...process.env, ...(opts.env ?? {}) };
  return spawn("pnpm", ["exec", "tsx", CLI_ENTRY, ...args], {
    env,
    cwd: new URL("../../..", import.meta.url).pathname,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readFirstStdoutLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for stdout; stderr=${JSON.stringify(stderr)}`));
    }, 10_000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf("\n");
      if (newline >= 0) {
        cleanup();
        resolve(stdout.slice(0, newline));
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString();
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`process exited before stdout line; code=${code}; stderr=${JSON.stringify(stderr)}`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
    child.on("error", onError);
  });
}

function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function parseFirstJson(text: string): unknown {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  if (!line) throw new Error(`no JSON line in output: ${JSON.stringify(text)}`);
  return JSON.parse(line);
}

function parseLastJson(text: string): unknown {
  // Pretty-printed JSON is multi-line; for our tests we use compact mode so
  // each command emits exactly one line of JSON.
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error(`no JSON line in output: ${JSON.stringify(text)}`);
  return JSON.parse(lines[lines.length - 1]!);
}

let tmpRoot: string;
let dbPath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "frick-cli-"));
  dbPath = join(tmpRoot, "frick.sqlite");
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe("frick --help", () => {
  it("lists available commands", async () => {
    const result = await runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    const body = parseFirstJson(result.stdout) as { commands: Array<{ name: string }> };
    const names = body.commands.map((c) => c.name);
    expect(names).toContain("doctor");
    expect(names).toContain("migrate");
    expect(names).toContain("tenants");
    expect(names).toContain("schema");
    expect(names).toContain("reset");
    expect(names).toContain("inspect");
    expect(names).toContain("verify");
    expect(names).toContain("dev");
    expect(names).toContain("deploy");
    expect(names).toContain("dashboard");
    expect(names).toContain("mcp");
  });
});

describe("frick mcp", () => {
  it("prints MCP client config without starting stdio mode", async () => {
    const result = await runCli([
      "mcp",
      "--print-config",
      "--endpoint",
      "http://127.0.0.1:4199",
      "--tenant",
      "tenant-dev",
      "--user",
      "user-ada",
    ]);
    expect(result.exitCode).toBe(0);
    const body = parseFirstJson(result.stdout) as {
      ok: boolean;
      transport: string;
      command: string;
      args: string[];
      endpoint: string;
      readonly: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.transport).toBe("stdio");
    expect(body.command).toBe("frick");
    expect(body.args).toContain("mcp");
    expect(body.args).toContain("--endpoint");
    expect(body.endpoint).toBe("http://127.0.0.1:4199");
    expect(body.readonly).toBe(true);
  });
});

describe("frick dashboard", () => {
  it("starts the static dashboard server and reports its URL", async () => {
    const child = spawnCli([
      "dashboard",
      "--port",
      "0",
      "--endpoint",
      "http://127.0.0.1:4199",
    ]);
    try {
      const line = await readFirstStdoutLine(child);
      const body = JSON.parse(line) as { ok: boolean; url: string; endpoint: string; port: number };
      expect(body.ok).toBe(true);
      expect(body.port).toBeGreaterThan(0);
      expect(body.endpoint).toBe("http://127.0.0.1:4199");
      expect(body.url).toContain("endpoint=http%3A%2F%2F127.0.0.1%3A4199");

      const index = await fetch(body.url);
      expect(index.status).toBe(200);
      expect(await index.text()).toContain("Fricken Dashboard");

      const script = await fetch(new URL("/dashboard.js", body.url));
      expect(script.status).toBe(200);
      expect(await script.text()).toContain("fricken-dashboard:endpoint");
    } finally {
      await stopChild(child);
    }
  });

  it("rejects an invalid port", async () => {
    const result = await runCli(["dashboard", "--port", "nope"]);
    expect(result.exitCode).toBe(2);
    const err = parseLastJson(result.stderr) as { error: { code: string; message: string } };
    expect(err.error.code).toBe("cli.usage");
    expect(err.error.message).toContain("--port");
  });
});

describe("frick dev", () => {
  it("prints the Redpanda profile plan without starting Docker", async () => {
    const result = await runCli(["dev", "--profile", "redpanda", "--dry-run"]);
    expect(result.exitCode).toBe(0);
    const body = parseFirstJson(result.stdout) as {
      ok: boolean;
      command: string;
      profile: string;
      composeFile: string;
      env: Record<string, string>;
      steps: string[];
      started: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.command).toBe("dev");
    expect(body.profile).toBe("redpanda");
    expect(body.composeFile).toContain("ops/local/redpanda.compose.yaml");
    expect(body.env.FRICK_PLATFORM_EVENTS_DRIVER).toBe("kafka");
    expect(body.env.FRICK_PLATFORM_EVENTS_KAFKA_BROKERS).toBe("127.0.0.1:19092");
    expect(body.env.FRICK_OTEL_ENABLED).toBe("true");
    expect(body.env.FRICK_OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://127.0.0.1:4318");
    expect(body.steps).toContain("docker compose up -d --wait redpanda otel-collector");
    expect(body.started).toBe(false);
  });

  it("prints the SQLite profile plan without Docker", async () => {
    const result = await runCli(["dev", "--dry-run"]);
    expect(result.exitCode).toBe(0);
    const body = parseFirstJson(result.stdout) as {
      ok: boolean;
      profile: string;
      composeFile?: string;
      env: Record<string, string>;
      steps: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.profile).toBe("sqlite");
    expect(body.composeFile).toBeUndefined();
    expect(body.env.FRICK_PLATFORM_EVENTS_DRIVER).toBe("sqlite");
    expect(body.steps).not.toContain("docker compose up -d --wait redpanda otel-collector");
  });

  it("rejects unknown dev profiles", async () => {
    const result = await runCli(["dev", "--profile", "nope", "--dry-run"]);
    expect(result.exitCode).toBe(2);
    const err = parseLastJson(result.stderr) as { error: { code: string; message: string } };
    expect(err.error.code).toBe("cli.usage");
    expect(err.error.message).toContain("--profile");
  });
});

describe("frick deploy", () => {
  it("prints the production compose deployment plan without starting Docker", async () => {
    const result = await runCli(["deploy", "--profile", "compose", "--dry-run"]);
    expect(result.exitCode).toBe(0);
    const body = parseFirstJson(result.stdout) as {
      ok: boolean;
      command: string;
      profile: string;
      composeFiles: string[];
      env: Record<string, string>;
      services: string[];
      steps: string[];
      started: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.command).toBe("deploy");
    expect(body.profile).toBe("compose");
    expect(body.composeFiles).toHaveLength(1);
    expect(body.composeFiles[0]).toContain("ops/deploy/compose.yaml");
    expect(body.env.FRICK_ENV).toBe("production");
    expect(body.env.FRICK_PLATFORM_EVENTS_DRIVER).toBe("kafka");
    expect(body.env.FRICK_PLATFORM_EVENTS_KAFKA_BROKERS).toBe("redpanda:9092");
    expect(body.env.FRICK_OTEL_ENABLED).toBe("true");
    expect(body.env.FRICK_OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://otel-collector:4318");
    expect(body.services).toEqual(["frick-server", "redpanda", "otel-collector"]);
    expect(body.steps).toContain("docker compose -f ops/deploy/compose.yaml up -d --wait");
    expect(body.started).toBe(false);
  });

  it("prints the lightweight SQLite deployment plan", async () => {
    const result = await runCli(["deploy", "--profile", "lightweight", "--dry-run"]);
    expect(result.exitCode).toBe(0);
    const body = parseFirstJson(result.stdout) as {
      ok: boolean;
      profile: string;
      composeFiles: string[];
      env: Record<string, string>;
      services: string[];
      started: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.profile).toBe("lightweight");
    expect(body.composeFiles[0]).toContain("ops/deploy/lightweight.compose.yaml");
    expect(body.env.FRICK_ENV).toBe("production");
    expect(body.env.FRICK_PLATFORM_EVENTS_DRIVER).toBe("sqlite");
    expect(body.env.FRICK_OTEL_ENABLED).toBe("false");
    expect(body.services).toEqual(["frick-server"]);
    expect(body.started).toBe(false);
  });

  it("rejects unknown deployment profiles", async () => {
    const result = await runCli(["deploy", "--profile", "nope", "--dry-run"]);
    expect(result.exitCode).toBe(2);
    const err = parseLastJson(result.stderr) as { error: { code: string; message: string } };
    expect(err.error.code).toBe("cli.usage");
    expect(err.error.message).toContain("--profile");
  });
});

describe("frick schema check", () => {
  it("emits the foundation schema identity", async () => {
    const result = await runCli(["schema", "check"]);
    expect(result.exitCode).toBe(0);
    const body = parseFirstJson(result.stdout) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.schemaId).toBe("string");
    expect(typeof body.schemaHash).toBe("string");
  });
});

describe("frick migrate", () => {
  it("status against a fresh db shows all migrations pending", async () => {
    const result = await runCli(["migrate", "status", "--db-path", dbPath, "--env", "development"]);
    expect(result.exitCode).toBe(0);
    const body = parseLastJson(result.stdout) as { applied: unknown[]; pending: unknown[] };
    expect(body.applied).toHaveLength(0);
    expect(body.pending.length).toBeGreaterThan(0);
  });

  it("up applies migrations and status then reports them as applied", async () => {
    const up = await runCli(["migrate", "up", "--db-path", dbPath, "--env", "development"]);
    expect(up.exitCode).toBe(0);
    const upBody = parseLastJson(up.stdout) as { applied: unknown[] };
    expect(upBody.applied.length).toBeGreaterThan(0);

    const status = await runCli(["migrate", "status", "--db-path", dbPath, "--env", "development"]);
    expect(status.exitCode).toBe(0);
    const body = parseLastJson(status.stdout) as { applied: unknown[]; pending: unknown[] };
    expect(body.applied.length).toBeGreaterThan(0);
    expect(body.pending).toHaveLength(0);
  });

  it("up against production-mode config requires --confirm-prod", async () => {
    const result = await runCli(["migrate", "up", "--db-path", dbPath, "--env", "production"]);
    expect(result.exitCode).toBe(3);
    const err = parseLastJson(result.stderr) as { error: { code: string } };
    expect(err.error.code).toBe("cli.refused");
  });
});

describe("frick doctor", () => {
  it("exits 0 against a healthy migrated db", async () => {
    await runCli(["migrate", "up", "--db-path", dbPath, "--env", "development"]);
    const result = await runCli(["doctor", "--db-path", dbPath, "--env", "development"]);
    expect(result.exitCode).toBe(0);
    const body = parseLastJson(result.stdout) as { ok: boolean; schema: { ok: boolean }; db: { ok: boolean } };
    expect(body.ok).toBe(true);
    expect(body.schema.ok).toBe(true);
    expect(body.db.ok).toBe(true);
  });

  it("exits 1 when db connectivity fails", async () => {
    // Pass a path inside a nonexistent directory tree, which will fail to open
    // because we don't auto-create directories for the doctor probe.
    const result = await runCli([
      "doctor",
      "--db-path",
      "/this/path/does/not/exist/frick.sqlite",
      "--env",
      "development",
    ]);
    expect(result.exitCode).toBe(1);
    const body = parseLastJson(result.stdout) as { ok: boolean; db: { ok: boolean } };
    expect(body.ok).toBe(false);
    expect(body.db.ok).toBe(false);
  });
});

describe("frick reset", () => {
  it("succeeds against a development-mode config with --dev", async () => {
    await runCli(["migrate", "up", "--db-path", dbPath, "--env", "development"]);
    const result = await runCli(["reset", "--dev", "--db-path", dbPath, "--env", "development"]);
    expect(result.exitCode).toBe(0);
    const body = parseLastJson(result.stdout) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("refuses without --dev", async () => {
    const result = await runCli(["reset", "--db-path", dbPath, "--env", "development"]);
    expect(result.exitCode).toBe(3);
    const err = parseLastJson(result.stderr) as { error: { code: string } };
    expect(err.error.code).toBe("cli.refused");
  });

  it("refuses against a production-mode config", async () => {
    const result = await runCli(["reset", "--dev", "--db-path", dbPath, "--env", "production"]);
    expect(result.exitCode).toBe(3);
    const err = parseLastJson(result.stderr) as { error: { code: string } };
    expect(err.error.code).toBe("cli.refused");
  });
});

describe("frick tenants", () => {
  it("list shows the _default tenant after migrations", async () => {
    await runCli(["migrate", "up", "--db-path", dbPath, "--env", "development"]);
    const result = await runCli(["tenants", "list", "--db-path", dbPath, "--env", "development"]);
    expect(result.exitCode).toBe(0);
    const body = parseLastJson(result.stdout) as { tenants: Array<{ tenantId: string }> };
    const ids = body.tenants.map((t) => t.tenantId);
    expect(ids).toContain("_default");
  });

  it("create inserts a new tenant row", async () => {
    await runCli(["migrate", "up", "--db-path", dbPath, "--env", "development"]);
    const created = await runCli([
      "tenants",
      "create",
      "tenant-x",
      "--display-name",
      "Tenant X",
      "--db-path",
      dbPath,
      "--env",
      "development",
    ]);
    expect(created.exitCode).toBe(0);
    const body = parseLastJson(created.stdout) as { ok: boolean; tenant: { tenantId: string } };
    expect(body.ok).toBe(true);
    expect(body.tenant.tenantId).toBe("tenant-x");

    const list = await runCli(["tenants", "list", "--db-path", dbPath, "--env", "development"]);
    const listBody = parseLastJson(list.stdout) as { tenants: Array<{ tenantId: string }> };
    expect(listBody.tenants.map((t) => t.tenantId)).toContain("tenant-x");
  });
});

describe("frick inspect", () => {
  it("server emits schema identity + config", async () => {
    await runCli(["migrate", "up", "--db-path", dbPath, "--env", "development"]);
    const result = await runCli(["inspect", "server", "--db-path", dbPath, "--env", "development"]);
    expect(result.exitCode).toBe(0);
    const body = parseLastJson(result.stdout) as { schemaId: string; env: string };
    expect(typeof body.schemaId).toBe("string");
    expect(body.env).toBe("development");
  });

  it("jobs emits availability record", async () => {
    await runCli(["migrate", "up", "--db-path", dbPath, "--env", "development"]);
    const result = await runCli(["inspect", "jobs", "--db-path", dbPath, "--env", "development"]);
    expect(result.exitCode).toBe(0);
    const body = parseLastJson(result.stdout) as { available: boolean };
    expect(typeof body.available).toBe("boolean");
  });
});

describe("frick backup / restore", () => {
  it("backup --output writes valid NDJSON that restore can consume", async () => {
    await runCli(["migrate", "up", "--db-path", dbPath, "--env", "development"]);
    const backupPath = join(tmpRoot, "backup.ndjson");
    const backup = await runCli([
      "backup",
      "--tenant-id",
      "_default",
      "--output",
      backupPath,
      "--db-path",
      dbPath,
      "--env",
      "development",
    ]);
    expect(backup.exitCode).toBe(0);
    const body = parseLastJson(backup.stdout) as { ok: boolean; rows: number };
    expect(body.ok).toBe(true);
    expect(body.rows).toBeGreaterThan(0);

    const restoreDbPath = join(tmpRoot, "restore.sqlite");
    await runCli(["migrate", "up", "--db-path", restoreDbPath, "--env", "development"]);
    const restore = await runCli([
      "restore",
      "--input",
      backupPath,
      "--confirm",
      "yes",
      "--overwrite",
      "--db-path",
      restoreDbPath,
      "--env",
      "development",
    ]);
    expect(restore.exitCode).toBe(0);
    const report = parseLastJson(restore.stdout) as {
      schemaCompatibility: { matched: boolean };
    };
    expect(report.schemaCompatibility.matched).toBe(true);
  });

  it("restore without --confirm yes is refused with exit 3", async () => {
    await runCli(["migrate", "up", "--db-path", dbPath, "--env", "development"]);
    const result = await runCli([
      "restore",
      "--input",
      join(tmpRoot, "missing.ndjson"),
      "--db-path",
      dbPath,
      "--env",
      "development",
    ]);
    expect(result.exitCode).toBe(3);
  });
});

describe("frick lint", () => {
  it("lints the current schema and exits 0 when clean", async () => {
    const result = await runCli(["lint"]);
    expect(result.exitCode).toBe(0);
    const summary = parseLastJson(result.stdout) as { ok: boolean; breaking: number };
    expect(summary.ok).toBe(true);
    expect(summary.breaking).toBe(0);
  });

  it("exits 1 with breaking findings when --against drops an object", async () => {
    // Spawn schema check to harvest the live foundation schema, then mutate
    // a hand-rolled "previous" snapshot that includes an extra object the
    // current schema is missing — that's a removal from previous → breaking.
    const previousPath = join(tmpRoot, "previous.json");
    const previous = {
      name: "frick-foundation",
      schemaId: "frick-foundation",
      schemaVersion: "0.1.0",
      schemaRevision: 1,
      minimumClientRevision: 1,
      minimumServerRevision: 1,
      protocol: "frick.realtime",
      protocolVersion: 1,
      compatibility: "greenfield-cutover",
      hash: "frick-foundation-fake",
      objects: [
        {
          id: 9999,
          name: "DroppedType",
          fields: [{ id: 1, name: "value", kind: "string", required: true }],
          indexes: [],
        },
      ],
      streams: [],
      events: [],
      presences: [],
      signals: [],
      blobs: [],
      jobs: [],
      projections: [],
    };
    writeFileSync(previousPath, JSON.stringify(previous));
    const result = await runCli(["lint", "--against", previousPath]);
    expect(result.exitCode).toBe(1);
    const lines = result.stdout.split("\n").filter((l) => l.trim().length > 0);
    const findings = lines.slice(0, -1).map((l) => JSON.parse(l)) as Array<{
      ruleId: string;
      severity: string;
    }>;
    expect(findings.some((f) => f.ruleId === "object.removed")).toBe(true);
    const summary = JSON.parse(lines[lines.length - 1]!) as {
      ok: boolean;
      breaking: number;
    };
    expect(summary.ok).toBe(false);
    expect(summary.breaking).toBeGreaterThanOrEqual(1);
  });
});

describe("frick init / scaffold", () => {
  it("init creates the expected file tree", async () => {
    const appDir = join(tmpRoot, "app");
    const result = await runCli(["init", appDir, "--no-install"]);
    expect(result.exitCode).toBe(0);
    const body = parseLastJson(result.stdout) as {
      ok: boolean;
      created: string[];
      install: { skipped?: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.install.skipped).toBe(true);
    for (const relative of [
      "package.json",
      "tsconfig.json",
      "frick.config.json",
      "src/schema.ts",
      "src/server.ts",
      "tests/smoke.test.ts",
    ]) {
      expect(existsSync(join(appDir, relative))).toBe(true);
    }
    const serverSource = readFileSync(join(appDir, "src/server.ts"), "utf8");
    expect(serverSource).toContain("await app.listen();");
    expect(serverSource).not.toContain("app.start");
    const smokeSource = readFileSync(join(appDir, "tests/smoke.test.ts"), "utf8");
    expect(smokeSource).toContain("await app.listen();");
    expect(smokeSource).toContain("app.httpUrl");
    expect(smokeSource).toContain("/health");
    expect(smokeSource).toContain("await app.close();");
    expect(smokeSource).not.toContain("app.start");
  });

  it("init can install agent harnesses and emit MCP config", async () => {
    const appDir = join(tmpRoot, "agent-app");
    const result = await runCli([
      "init",
      appDir,
      "--no-install",
      "--agents",
      "all",
      "--mcp",
      "--port",
      "4111",
    ]);
    expect(result.exitCode).toBe(0);
    const body = parseLastJson(result.stdout) as {
      ok: boolean;
      agentKit?: { ok: boolean; harnesses: string[]; written: string[] };
      mcp?: { endpoint: string; readonly: boolean; command: string; args: string[] };
    };
    expect(body.ok).toBe(true);
    expect(body.agentKit?.ok).toBe(true);
    expect(body.agentKit?.harnesses).toEqual(["codex", "claude", "cursor"]);
    expect(body.agentKit?.written.some((path) => path.endsWith(".cursor/rules/frick-mcp.mdc"))).toBe(true);
    expect(body.mcp).toMatchObject({
      endpoint: "http://127.0.0.1:4111",
      readonly: true,
      command: "frick",
    });
    expect(body.mcp?.args).toEqual(["mcp", "--endpoint", "http://127.0.0.1:4111"]);
    expect(existsSync(join(appDir, "docs/frick/spine.md"))).toBe(true);
    expect(existsSync(join(appDir, ".codex/agents/frick-mcp.toml"))).toBe(true);
    expect(existsSync(join(appDir, ".claude/agents/frick-mcp.md"))).toBe(true);
    expect(existsSync(join(appDir, ".cursor/rules/frick-mcp.mdc"))).toBe(true);
  });

  it("scaffold object Profile adds a Profile object stub", async () => {
    const appDir = join(tmpRoot, "app");
    await runCli(["init", appDir, "--no-install"]);
    const result = await runCli(["scaffold", "object", "Profile", "--directory", appDir]);
    expect(result.exitCode).toBe(0);
    const body = parseLastJson(result.stdout) as { ok: boolean; kind: string; name: string };
    expect(body.ok).toBe(true);
    expect(body.kind).toBe("object");
    expect(body.name).toBe("Profile");
    const schemaSource = readFileSync(join(appDir, "src/schema.ts"), "utf8");
    expect(schemaSource).toContain("// frick:objects:id 1 Profile");
    expect(schemaSource).toContain('name: "Profile"');
  });

  it("scaffold projection profile-index creates the projection file", async () => {
    const appDir = join(tmpRoot, "app");
    await runCli(["init", appDir, "--no-install"]);
    const result = await runCli([
      "scaffold",
      "projection",
      "profile-index",
      "--directory",
      appDir,
    ]);
    expect(result.exitCode).toBe(0);
    const body = parseLastJson(result.stdout) as {
      ok: boolean;
      projectionPath: string;
      serverPath: string;
    };
    expect(body.ok).toBe(true);
    expect(existsSync(join(appDir, "src/projections/profile-index.ts"))).toBe(true);
    const serverSource = readFileSync(join(appDir, "src/server.ts"), "utf8");
    expect(serverSource).toContain("createProfileIndexProjection");
  });
});

describe("unknown command", () => {
  it("returns exit 2 and a JSON error on stderr", async () => {
    const result = await runCli(["nope"]);
    expect(result.exitCode).toBe(2);
    const err = parseLastJson(result.stderr) as { error: { code: string } };
    expect(err.error.code).toBe("cli.unknown_command");
  });
});
