import { afterEach, describe, expect, it } from "vitest";
import { productTestSchema } from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";
import { createConsoleLogger, type FrickLogger } from "../src/logger.js";

interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields: Record<string, unknown>;
}

function createCapturingLogger(): { logger: FrickLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];

  const capture = (line: string): void => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const fields = { ...parsed };
    delete fields.ts;
    delete fields.level;
    delete fields.msg;
    const { level, msg } = parsed;
    entries.push({ level: level as LogEntry["level"], message: String(msg), fields });
  };

  return {
    logger: createConsoleLogger({ logLevel: "debug" }, { out: capture, err: capture }),
    entries,
  };
}

interface Started {
  httpUrl: string;
  entries: LogEntry[];
  close: () => Promise<void>;
}

async function start(): Promise<Started> {
  const { logger, entries } = createCapturingLogger();
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    schema: productTestSchema,
    logger,
    config: { env: "test", demoAuthEnabled: true },
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("no address");
  }
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    entries,
    close: server.close,
  };
}

function requestLogs(entries: LogEntry[]): LogEntry[] {
  return entries.filter((e) => e.message === "frick.http.request");
}

describe("per-request logging", () => {
  let cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    const closers = cleanup;
    cleanup = [];
    for (const close of closers) {
      await close();
    }
  });

  it("emits one frick.http.request log line per request", async () => {
    const s = await start();
    cleanup.push(s.close);

    const response = await fetch(`${s.httpUrl}/health`);
    expect(response.status).toBe(200);
    await response.text();

    const logs = requestLogs(s.entries);
    expect(logs).toHaveLength(1);
    const f = logs[0].fields;
    expect(typeof f.requestId).toBe("string");
    expect(f.method).toBe("GET");
    expect(f.path).toBe("/health");
    expect(f.status).toBe(200);
    expect(typeof f.durationMs).toBe("number");
  });

  it("includes tenantId and userId for authenticated requests", async () => {
    const s = await start();
    cleanup.push(s.close);

    const loginResponse = await fetch(`${s.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-ada" }),
    });
    expect(loginResponse.status).toBe(200);
    const session = (await loginResponse.json()) as { sessionToken: string };

    s.entries.length = 0;

    const inbox = await fetch(`${s.httpUrl}/objects?type=User`, {
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    expect(inbox.status).toBe(200);
    await inbox.json();

    const logs = requestLogs(s.entries);
    expect(logs).toHaveLength(1);
    expect(logs[0].fields).toMatchObject({
      method: "GET",
      path: "/objects",
      status: 200,
      tenantId: "_default",
      userId: "user-ada",
    });
  });

  it("child logger redacts sensitive inherited fields", async () => {
    const { logger, entries } = createCapturingLogger();
    logger.child({ password: "supersecret", credentials: { privateKey: "pem", publicKey: "pub" } }).info("login");
    expect(entries[0].fields.password).toBe("<redacted>");
    expect(entries[0].fields.credentials).toEqual({ privateKey: "<redacted>", publicKey: "pub" });
  });

  it("child logger merges parent and per-emission fields", async () => {
    const { logger, entries } = createCapturingLogger();
    logger.child({ a: 1 }).info("msg", { b: 2 });
    expect(entries[0].fields).toMatchObject({ a: 1, b: 2 });
  });

  it("still emits the log for 4xx unauthenticated requests", async () => {
    const s = await start();
    cleanup.push(s.close);

    const response = await fetch(`${s.httpUrl}/objects?type=User`);
    expect(response.status).toBe(401);
    await response.json();

    const logs = requestLogs(s.entries);
    expect(logs).toHaveLength(1);
    expect(logs[0].fields.status).toBe(401);
    expect(logs[0].fields.tenantId).toBeUndefined();
    expect(logs[0].fields.userId).toBeUndefined();
  });
});
