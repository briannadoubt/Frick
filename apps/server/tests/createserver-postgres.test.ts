/**
 * End-to-end smoke test: createFrickServer running on Postgres (FR-146 keystone).
 *
 * Requires a live Postgres reachable via FRICK_DATABASE_URL; skipped otherwise
 * (same gate as the other pg-* suites). Each run uses a uniquely-named schema,
 * pushed onto the connection via `options=-c search_path=…` so every pooled
 * connection — including the ones createFrickServer opens internally — lands
 * there, isolating the run from `public` and from parallel workers.
 *
 *   docker run -d -e POSTGRES_PASSWORD=frick -e POSTGRES_DB=frick_test \
 *     -p 5433:5432 postgres:16-alpine
 *   FRICK_DATABASE_URL=postgres://postgres:frick@localhost:5433/frick_test \
 *     pnpm --filter @fricken/server exec vitest run tests/createserver-postgres.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { productTestSchema } from "@fricken/protocol";
import { createFrickServer } from "../src/server.js";

const DATABASE_URL = process.env.FRICK_DATABASE_URL;
const describeOrSkip = DATABASE_URL ? describe : describe.skip;

// Unique, non-`public` schema for this run.
const TEST_SCHEMA = `frick_smoke_${process.pid}`;

function urlWithSearchPath(base: string, schema: string): string {
  const u = new URL(base);
  // libpq startup option: every connection the pool opens runs in this schema.
  u.searchParams.set("options", `-c search_path=${schema}`);
  return u.toString();
}

let adminPool: Pool | undefined;
let server: Awaited<ReturnType<typeof startServer>> | undefined;

async function startServer(databaseUrl: string) {
  const srv = createFrickServer({
    port: 0,
    schema: productTestSchema,
    config: { dbDriver: "postgres", databaseUrl },
  });
  await srv.listen();
  const address = srv.server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    store: srv.store,
    close: srv.close,
  };
}

beforeAll(async () => {
  if (!DATABASE_URL) return;
  adminPool = new Pool({ connectionString: DATABASE_URL });
  await adminPool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
  await adminPool.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
  server = await startServer(urlWithSearchPath(DATABASE_URL, TEST_SCHEMA));
});

afterAll(async () => {
  await server?.close();
  if (adminPool) {
    await adminPool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await adminPool.end();
  }
});

async function devLogin(httpUrl: string, userId: string): Promise<string> {
  const res = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { sessionToken: string }).sessionToken;
}

describeOrSkip("createFrickServer on Postgres", () => {
  it("boots, runs migrations, and serves the schema", async () => {
    const res = await fetch(`${server!.httpUrl}/schema`);
    expect(res.status).toBe(200);
    const schema = (await res.json()) as { hash: string };
    expect(schema.hash).toBe(productTestSchema.hash);
  });

  it("authenticates and round-trips an object write/read through the PG stores", async () => {
    const token = await devLogin(server!.httpUrl, "user-ada");
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const write = await fetch(`${server!.httpUrl}/objects/Conversation/conversation-pg`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "group", title: "PG room", createdBy: "user-ada" }),
    });
    expect(write.status).toBe(201);

    // Reads go through the list endpoint (GET /objects?type=…); there is no
    // single-object GET route.
    const read = await fetch(`${server!.httpUrl}/objects?type=Conversation`, { headers });
    expect(read.status).toBe(200);
    const body = (await read.json()) as { data: Array<{ id: string; title?: string }> };
    const row = body.data.find((o) => o.id === "conversation-pg");
    expect(row?.title).toBe("PG room");
  });

  it("deletes an object through the PG store", async () => {
    const token = await devLogin(server!.httpUrl, "user-ada");
    const headers = { authorization: `Bearer ${token}` };
    const del = await fetch(`${server!.httpUrl}/objects/Conversation/conversation-pg`, {
      method: "DELETE",
      headers,
    });
    expect(del.status).toBeLessThan(300);
  });

  it("exposes the postgres driver dialect on the store", () => {
    // The store the server built is Postgres-backed.
    expect(server!.store.searchAdapter.id).toBe("postgres-tsvector");
  });
});
