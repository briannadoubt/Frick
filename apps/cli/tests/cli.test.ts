/**
 * CLI black-box tests. Each test spawns the CLI via `tsx` against a tmpdir
 * SQLite database, captures stdout/stderr, and asserts the JSON shape.
 *
 * Spawning a real process (rather than calling `run()` in-process) is what
 * gives confidence that argv parsing, exit codes, and the stdout/stderr
 * stream split all behave as a downstream automation script would see them.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("unknown command", () => {
  it("returns exit 2 and a JSON error on stderr", async () => {
    const result = await runCli(["nope"]);
    expect(result.exitCode).toBe(2);
    const err = parseLastJson(result.stderr) as { error: { code: string } };
    expect(err.error.code).toBe("cli.unknown_command");
  });
});
