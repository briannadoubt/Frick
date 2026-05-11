import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createFrickServer } from "../src/server.js";
import type { AdminAuditRow } from "../src/storage/admin-audit-store.js";

const ADMIN_TOKEN = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";
const ADMIN_FINGERPRINT = createHash("sha256")
  .update(ADMIN_TOKEN)
  .digest("hex")
  .slice(0, 12);

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("admin audit log", () => {
  it("records a successful tenant create as outcome=allow", async () => {
    app = await startServer();
    const response = await postTenant("tenant-audit-create", "Audit Create");
    expect(response.status).toBe(201);

    const entries = await listAudit();
    const row = entries.find((r) => r.action === "tenants.create");
    expect(row).toBeDefined();
    expect(row?.outcome).toBe("allow");
    expect(row?.target).toBe("tenant-audit-create");
    expect(row?.adminTokenFingerprint).toBe(ADMIN_FINGERPRINT);
    expect(row?.adminTokenFingerprint).not.toContain(ADMIN_TOKEN);
    expect(row?.detail && JSON.parse(row.detail)).toEqual({ displayName: "Audit Create" });
  });

  it("records a duplicate-id tenant create as outcome=deny with conflict detail", async () => {
    app = await startServer();
    expect((await postTenant("tenant-dup")).status).toBe(201);
    const dup = await postTenant("tenant-dup");
    expect(dup.status).toBe(409);

    const entries = await listAudit({ action: "tenants.create" });
    const denied = entries.find((r) => r.outcome === "deny");
    expect(denied).toBeDefined();
    expect(denied?.target).toBe("tenant-dup");
    expect(denied?.detail && JSON.parse(denied.detail)).toMatchObject({
      reason: "tenantExists",
    });
  });

  it("records archive as outcome=allow", async () => {
    app = await startServer();
    await postTenant("tenant-archive-me");
    const archive = await fetch(
      `${app.httpUrl}/_frick/admin/tenants/tenant-archive-me/archive`,
      { method: "POST", headers: adminHeaders() },
    );
    expect(archive.status).toBe(200);

    const entries = await listAudit({ action: "tenants.archive" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.outcome).toBe("allow");
    expect(entries[0]?.target).toBe("tenant-archive-me");
  });

  it("returns audit-log rows in reverse-chronological order", async () => {
    app = await startServer();
    await postTenant("tenant-order-a");
    await postTenant("tenant-order-b");
    await postTenant("tenant-order-c");

    const entries = await listAudit({ action: "tenants.create" });
    expect(entries.map((r) => r.target)).toEqual([
      "tenant-order-c",
      "tenant-order-b",
      "tenant-order-a",
    ]);
    // occurred_at is non-decreasing as we walk forward in time, so
    // reverse-chronological listing means descending by occurredAt.
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i - 1]!.occurredAt >= entries[i]!.occurredAt).toBe(true);
    }
  });

  it("filters by action exact-match", async () => {
    app = await startServer();
    await postTenant("tenant-filter-a");
    await postTenant("tenant-filter-b");
    await fetch(`${app.httpUrl}/_frick/admin/tenants/tenant-filter-a/archive`, {
      method: "POST",
      headers: adminHeaders(),
    });

    const archives = await listAudit({ action: "tenants.archive" });
    expect(archives).toHaveLength(1);
    expect(archives[0]?.action).toBe("tenants.archive");

    const creates = await listAudit({ action: "tenants.create" });
    expect(creates.map((r) => r.action)).toEqual(["tenants.create", "tenants.create"]);
  });

  it("filters by since=<isoLater>", async () => {
    app = await startServer();
    await postTenant("tenant-since-old");
    // Sleep a touch so the new row's occurred_at is strictly later.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const cutoff = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await postTenant("tenant-since-new");

    const entries = await listAudit({ since: cutoff });
    expect(entries.map((r) => r.target)).toEqual(["tenant-since-new"]);
  });

  it("limit caps results", async () => {
    app = await startServer();
    for (const id of ["t-limit-1", "t-limit-2", "t-limit-3"]) {
      await postTenant(id);
    }
    const entries = await listAudit({ limit: 2 });
    expect(entries).toHaveLength(2);
  });

  it("non-admin request to /_frick/admin/audit-log is forbidden with envelope", async () => {
    app = await startServer();
    const login = await fetch(`${app.httpUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-ada" }),
    });
    const session = (await login.json()) as { sessionToken: string };
    const response = await fetch(`${app.httpUrl}/_frick/admin/audit-log`, {
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("auth.forbidden");
  });

  it("does not store the raw admin token anywhere in the audit row", async () => {
    app = await startServer();
    await postTenant("tenant-fingerprint-check");
    const entries = await listAudit();
    for (const entry of entries) {
      expect(entry.adminTokenFingerprint).toBe(ADMIN_FINGERPRINT);
      expect(entry.adminTokenFingerprint.length).toBe(12);
      expect(entry.adminTokenFingerprint).not.toContain(ADMIN_TOKEN);
      if (entry.detail) {
        expect(entry.detail).not.toContain(ADMIN_TOKEN);
      }
    }
  });
});

function adminHeaders(): Record<string, string> {
  return { authorization: `Bearer ${ADMIN_TOKEN}` };
}

async function postTenant(tenantId: string, displayName?: string) {
  return fetch(`${app!.httpUrl}/_frick/admin/tenants`, {
    method: "POST",
    headers: { ...adminHeaders(), "content-type": "application/json" },
    body: JSON.stringify({
      tenantId,
      ...(displayName !== undefined ? { displayName } : {}),
    }),
  });
}

async function listAudit(
  filters: { since?: string; action?: string; limit?: number } = {},
): Promise<AdminAuditRow[]> {
  const params = new URLSearchParams();
  if (filters.since !== undefined) params.set("since", filters.since);
  if (filters.action !== undefined) params.set("action", filters.action);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  const qs = params.toString();
  const url = `${app!.httpUrl}/_frick/admin/audit-log${qs ? `?${qs}` : ""}`;
  const response = await fetch(url, { headers: adminHeaders() });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { entries: AdminAuditRow[] };
  return body.entries;
}

async function startServer() {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    config: { adminToken: ADMIN_TOKEN },
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    close: server.close,
  };
}
