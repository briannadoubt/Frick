import { describe, expect, it } from "vitest";
import { productTestSchema } from "@fricken/protocol";
import { dumpFrickDatabase, type FrickDumpHeader } from "../src/backup/dump.js";
import { FrickStore } from "../src/store.js";

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of iter) out.push(line);
  return out;
}

describe("dumpFrickDatabase", () => {
  it("emits a valid header line followed by row lines", async () => {
    const store = new FrickStore({ path: ":memory:", schema: productTestSchema });
    try {
      // Default seeding no longer populates the foundation; explicitly insert
      // an object so the dump contains an "objects" row.
      await store.upsertObject("_default", "User", "user-seed", { displayName: "Seed" });
      const lines = await collect(dumpFrickDatabase(store, { tenantId: "_default" }));
      expect(lines.length).toBeGreaterThan(1);
      const header = JSON.parse(lines[0]!) as { type: string; row: FrickDumpHeader };
      expect(header.type).toBe("header");
      expect(header.row.frickFormat).toBe(1);
      expect(header.row.tenantId).toBe("_default");
      expect(header.row.schemaHash).toBe(store.schema.hash);
      expect(Array.isArray(header.row.appliedMigrations)).toBe(true);
      for (const line of lines.slice(1)) {
        const parsed = JSON.parse(line) as { type: string; row: unknown };
        expect(typeof parsed.type).toBe("string");
        expect(parsed.row).toBeTypeOf("object");
      }
      const types = lines.slice(1).map((l) => (JSON.parse(l) as { type: string }).type);
      expect(types).toContain("objects");
      // Per-tenant dump must NOT include admin_audit_log or frick_migrations.
      expect(types).not.toContain("admin_audit_log");
      expect(types).not.toContain("frick_migrations");
    } finally {
      store.close();
    }
  });

  it("per-tenant dump only includes rows for the chosen tenant", async () => {
    const store = new FrickStore({ path: ":memory:", schema: productTestSchema });
    try {
      await store.tenants.create("tenant-alpha");
      await store.tenants.create("tenant-beta");
      await store.upsertObject("tenant-alpha", "User", "user-alpha-1", { displayName: "Alpha" });
      await store.upsertObject("tenant-beta", "User", "user-beta-1", { displayName: "Beta" });

      const alphaLines = await collect(
        dumpFrickDatabase(store, { tenantId: "tenant-alpha" }),
      );
      const objectRows = alphaLines
        .slice(1)
        .map((l) => JSON.parse(l) as { type: string; row: Record<string, unknown> })
        .filter((r) => r.type === "objects");
      expect(objectRows.length).toBe(1);
      expect(objectRows[0]!.row.tenant_id).toBe("tenant-alpha");
      expect(objectRows[0]!.row.object_id).toBe("user-alpha-1");
    } finally {
      store.close();
    }
  });

  it("includes blob_content with base64-encoded bytes inline", async () => {
    const store = new FrickStore({ path: ":memory:", schema: productTestSchema });
    try {
      await store.createBlobMetadata({
        blobId: "blob-1",
        ownerId: "user-ada",
        contentHash: "deadbeef",
        byteLength: 5,
        mimeType: "application/octet-stream",
      });
      await store.writeBlobContent("blob-1", new Uint8Array([1, 2, 3, 4, 5]));
      const lines = await collect(dumpFrickDatabase(store, { tenantId: "_default" }));
      const blobRows = lines
        .slice(1)
        .map((l) => JSON.parse(l) as { type: string; row: Record<string, unknown> })
        .filter((r) => r.type === "blob_content");
      expect(blobRows.length).toBe(1);
      const row = blobRows[0]!.row;
      expect(typeof row.content_base64).toBe("string");
      const decoded = Buffer.from(row.content_base64 as string, "base64");
      expect(Array.from(decoded)).toEqual([1, 2, 3, 4, 5]);
    } finally {
      store.close();
    }
  });

  it("per-tenant dump includes security-relevant framework tables for the chosen tenant", async () => {
    const store = new FrickStore({ path: ":memory:", seed: false, schema: productTestSchema });
    try {
      await store.tenants.create("tenant-alpha");
      await store.tenants.create("tenant-beta");
      await store.blobDerivatives.record({
        tenantId: "tenant-alpha",
        parentBlobId: "blob-parent-alpha",
        derivativeId: "thumb",
        processorId: "image-thumb",
        mimeType: "image/png",
        byteLength: 3,
        contentHash: "hash-alpha",
        storageKey: "derivative/blob-parent-alpha/thumb",
        content: Buffer.from([1, 2, 3]),
        metadata: { width: 64 },
      });
      await store.blobDerivatives.record({
        tenantId: "tenant-beta",
        parentBlobId: "blob-parent-beta",
        derivativeId: "thumb",
        processorId: "image-thumb",
        mimeType: "image/png",
        byteLength: 1,
        contentHash: "hash-beta",
        storageKey: "derivative/blob-parent-beta/thumb",
        content: Buffer.from([9]),
      });
      store.searchAdapter.upsert("tenant-alpha", "messages-fts", {
        docId: "event-alpha",
        text: "alpha secret",
        fields: { senderId: "user-alpha" },
      });
      store.searchAdapter.upsert("tenant-beta", "messages-fts", {
        docId: "event-beta",
        text: "beta secret",
        fields: { senderId: "user-beta" },
      });
      await store.tenantSettings.set("tenant-alpha", "retentionMs", 1234);
      await store.tenantSettings.set("tenant-beta", "retentionMs", 5678);

      const lines = await collect(dumpFrickDatabase(store, { tenantId: "tenant-alpha" }));
      const rows = lines
        .slice(1)
        .map((l) => JSON.parse(l) as { type: string; row: Record<string, unknown> });
      const byType = new Map<string, Array<Record<string, unknown>>>();
      for (const entry of rows) {
        byType.set(entry.type, [...(byType.get(entry.type) ?? []), entry.row]);
      }

      expect(byType.get("blob_derivatives")).toHaveLength(1);
      expect(byType.get("blob_derivatives")?.[0]?.tenant_id).toBe("tenant-alpha");
      expect(byType.get("blob_derivatives")?.[0]?.content_base64).toBe("AQID");
      expect(byType.get("search_indexes")).toHaveLength(1);
      expect(byType.get("search_indexes")?.[0]).toMatchObject({
        tenant_id: "tenant-alpha",
        doc_id: "event-alpha",
        text: "alpha secret",
      });
      expect(byType.get("tenant_settings")).toHaveLength(1);
      expect(byType.get("tenant_settings")?.[0]).toMatchObject({
        tenant_id: "tenant-alpha",
        setting_key: "retentionMs",
        setting_value: "1234",
      });
    } finally {
      store.close();
    }
  });

  it("per-tenant dump includes platform events and only matching delivery state", async () => {
    const store = new FrickStore({ path: ":memory:", seed: false, schema: productTestSchema });
    try {
      await store.tenants.create("tenant-alpha");
      await store.tenants.create("tenant-beta");
      const alpha = await store.platformEvents.publish({
        family: "analytics.user_event",
        name: "message.sent",
        source: "test",
        tenantId: "tenant-alpha",
        payload: { messageId: "alpha-message" },
      });
      const beta = await store.platformEvents.publish({
        family: "analytics.user_event",
        name: "message.sent",
        source: "test",
        tenantId: "tenant-beta",
        payload: { messageId: "beta-message" },
      });
      await await store.platformEvents.claim("analytics-worker", { batchSize: 10 });

      const lines = await collect(dumpFrickDatabase(store, { tenantId: "tenant-alpha" }));
      const rows = lines
        .slice(1)
        .map((l) => JSON.parse(l) as { type: string; row: Record<string, unknown> });
      const platformEvents = rows.filter((r) => r.type === "platform_events");
      const deliveries = rows.filter((r) => r.type === "platform_event_deliveries");

      expect(platformEvents).toHaveLength(1);
      expect(platformEvents[0]?.row).toMatchObject({
        event_id: alpha.id,
        tenant_id: "tenant-alpha",
      });
      expect(platformEvents[0]?.row.event_id).not.toBe(beta.id);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.row).toMatchObject({
        event_id: alpha.id,
        consumer: "analytics-worker",
        status: "claimed",
      });
    } finally {
      store.close();
    }
  });

  it("whole-database dump includes admin_audit_log and frick_migrations", async () => {
    const store = new FrickStore({ path: ":memory:", schema: productTestSchema });
    try {
      await store.adminAudit.record({
        adminTokenFingerprint: "abc123def456",
        action: "tenants.create",
        outcome: "allow",
      });
      const lines = await collect(dumpFrickDatabase(store, { tenantId: "all" }));
      const types = new Set(
        lines.slice(1).map((l) => (JSON.parse(l) as { type: string }).type),
      );
      expect(types.has("frick_migrations")).toBe(true);
      expect(types.has("admin_audit_log")).toBe(true);
    } finally {
      store.close();
    }
  });
});
