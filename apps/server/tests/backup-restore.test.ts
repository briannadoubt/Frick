import { describe, expect, it } from "vitest";
import { productTestSchema } from "@fricken/protocol";
import { dumpFrickDatabase } from "../src/backup/dump.js";
import { FrickRestoreRefusedError, restoreFrickDatabase } from "../src/backup/restore.js";
import { FrickStore } from "../src/store.js";

async function dumpToLines(store: FrickStore, tenantId: string): Promise<string[]> {
  const out: string[] = [];
  for await (const line of dumpFrickDatabase(store, { tenantId })) out.push(line);
  return out;
}

async function* fromLines(lines: string[]): AsyncIterable<string> {
  for (const line of lines) yield `${line}\n`;
}

describe("restoreFrickDatabase", () => {
  it("round-trips object and stream rows through dump/restore", async () => {
    const source = new FrickStore({ path: ":memory:", seed: false, schema: productTestSchema });
    try {
      await source.tenants.create("tenant-alpha");
      await source.upsertObject("tenant-alpha", "User", "user-ada", { displayName: "Ada" });
      await source.appendEvent({
        tenantId: "tenant-alpha",
        requestId: "req-1",
        replicaId: "replica-1",
        stream: "MessageStream",
        streamId: "conversation-1",
        event: "MessageSent",
        payload: { body: "hello" },
      });

      const lines = await dumpToLines(source, "tenant-alpha");
      const target = new FrickStore({ path: ":memory:", seed: false, schema: productTestSchema });
      try {
        const report = await restoreFrickDatabase({
          target,
          source: fromLines(lines),
          confirm: "yes",
        });
        expect(report.rowCountsByType.objects).toBe(1);
        expect(report.rowCountsByType.stream_events).toBe(1);
        expect(report.schemaCompatibility.matched).toBe(true);
        expect((await target.readObject("tenant-alpha", "User", "user-ada"))?.displayName).toBe(
          "Ada",
        );
        const events = await target.readEvents("tenant-alpha", "MessageStream", "conversation-1", 0);
        expect(events).toHaveLength(1);
        expect(events[0]!.event).toBe("MessageSent");
      } finally {
        target.close();
      }
    } finally {
      source.close();
    }
  });

  it("round-trips blob derivatives, search indexes, and tenant settings", async () => {
    const source = new FrickStore({ path: ":memory:", seed: false, schema: productTestSchema });
    try {
      await source.tenants.create("tenant-alpha");
      await source.blobDerivatives.record({
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
      await source.searchAdapter.upsert("tenant-alpha", "messages-fts", {
        docId: "event-alpha",
        text: "alpha secret",
        fields: { senderId: "user-alpha" },
      });
      await source.tenantSettings.set("tenant-alpha", "retentionMs", 1234);

      const lines = await dumpToLines(source, "tenant-alpha");
      const target = new FrickStore({ path: ":memory:", seed: false, schema: productTestSchema });
      try {
        const report = await restoreFrickDatabase({
          target,
          source: fromLines(lines),
          confirm: "yes",
        });
        expect(report.rowCountsByType.blob_derivatives).toBe(1);
        expect(report.rowCountsByType.search_indexes).toBe(1);
        expect(report.rowCountsByType.tenant_settings).toBe(1);

        const derivative = await target.blobDerivatives.read(
          "blob-parent-alpha",
          "thumb",
          "tenant-alpha",
        );
        expect(Array.from(derivative?.bytes ?? [])).toEqual([1, 2, 3]);
        expect(derivative?.row.metadata).toEqual({ width: 64 });
        expect(
          (
            await target.searchAdapter.query("tenant-alpha", {
              index: "messages-fts",
              q: "alpha",
              limit: 10,
            })
          ).total,
        ).toBe(1);
        expect(await target.tenantSettings.get("tenant-alpha", "retentionMs")).toBe(1234);
      } finally {
        target.close();
      }
    } finally {
      source.close();
    }
  });

  it("round-trips platform events and delivery state", async () => {
    const source = new FrickStore({ path: ":memory:", seed: false, schema: productTestSchema });
    try {
      await source.tenants.create("tenant-alpha");
      const receipt = await source.platformEvents.publish({
        family: "analytics.user_event",
        name: "message.sent",
        source: "test",
        tenantId: "tenant-alpha",
        payload: { messageId: "alpha-message" },
      });
      await source.platformEvents.claim("analytics-worker");

      const lines = await dumpToLines(source, "tenant-alpha");
      const target = new FrickStore({ path: ":memory:", seed: false, schema: productTestSchema });
      try {
        const report = await restoreFrickDatabase({
          target,
          source: fromLines(lines),
          confirm: "yes",
        });
        expect(report.rowCountsByType.platform_events).toBe(1);
        expect(report.rowCountsByType.platform_event_deliveries).toBe(1);

        const health = await target.platformEvents.health();
        expect(health).toMatchObject({
          retained: 1,
          claimed: 1,
          unclaimed: 0,
        });
        expect(await target.platformEvents.claim("analytics-worker")).toEqual([]);

        const [delivery] = await target.platformEvents.claim("export-worker");
        expect(delivery?.event.id).toBe(receipt.id);
        expect(delivery?.event.payload).toEqual({ messageId: "alpha-message" });
      } finally {
        target.close();
      }
    } finally {
      source.close();
    }
  });

  it("refuses to restore over a non-empty target without overwrite", async () => {
    const source = new FrickStore({ path: ":memory:", seed: false, schema: productTestSchema });
    const target = new FrickStore({ path: ":memory:", schema: productTestSchema });
    try {
      // Default seeding no longer populates the foundation, so explicitly
      // make the target non-empty before attempting a no-overwrite restore.
      await target.upsertObject("_default", "User", "user-existing", { displayName: "Existing" });
      const lines = await dumpToLines(source, "_default");
      await expect(
        restoreFrickDatabase({
          target,
          source: fromLines(lines),
          confirm: "yes",
        }),
      ).rejects.toBeInstanceOf(FrickRestoreRefusedError);
    } finally {
      source.close();
      target.close();
    }
  });

  it("overwrite truncates matching tenant scope first", async () => {
    const source = new FrickStore({ path: ":memory:", seed: false, schema: productTestSchema });
    const target = new FrickStore({ path: ":memory:", seed: false, schema: productTestSchema });
    try {
      await source.upsertObject("_default", "User", "user-source", { displayName: "Source" });
      await target.upsertObject("_default", "User", "user-stale", { displayName: "Stale" });
      const lines = await dumpToLines(source, "_default");
      const report = await restoreFrickDatabase({
        target,
        source: fromLines(lines),
        confirm: "yes",
        overwrite: true,
      });
      expect(report.rowCountsByType.objects).toBe(1);
      expect(await target.readObject("_default", "User", "user-stale")).toBeUndefined();
      expect((await target.readObject("_default", "User", "user-source"))?.displayName).toBe("Source");
    } finally {
      source.close();
      target.close();
    }
  });

  it("refuses on schema hash mismatch unless forceSchemaDrift", async () => {
    const source = new FrickStore({ path: ":memory:", seed: false, schema: productTestSchema });
    try {
      const lines = await dumpToLines(source, "_default");
      // Mutate the header schemaHash to simulate drift.
      const header = JSON.parse(lines[0]!) as { type: string; row: { schemaHash: string } };
      header.row.schemaHash = "00000000000000000000000000000000000000000000000000000000";
      const mutated = [JSON.stringify(header), ...lines.slice(1)];

      const target = new FrickStore({ path: ":memory:", seed: false, schema: productTestSchema });
      try {
        await expect(
          restoreFrickDatabase({
            target,
            source: fromLines(mutated),
            confirm: "yes",
          }),
        ).rejects.toMatchObject({ reason: "schemaHashMismatch" });

        const target2 = new FrickStore({ path: ":memory:", seed: false, schema: productTestSchema });
        try {
          const report = await restoreFrickDatabase({
            target: target2,
            source: fromLines(mutated),
            confirm: "yes",
            forceSchemaDrift: true,
          });
          expect(report.schemaCompatibility.matched).toBe(false);
        } finally {
          target2.close();
        }
      } finally {
        target.close();
      }
    } finally {
      source.close();
    }
  });

  it("reports malformed rows in skipped without aborting", async () => {
    const source = new FrickStore({ path: ":memory:", seed: false, schema: productTestSchema });
    try {
      await source.upsertObject("_default", "User", "user-ok", { displayName: "OK" });
      const lines = await dumpToLines(source, "_default");
      // Inject one malformed row plus one row with an unknown table type.
      const withBadRows = [
        lines[0]!,
        "not-json-at-all",
        JSON.stringify({ type: "no_such_table", row: { tenant_id: "_default" } }),
        ...lines.slice(1),
      ];
      const target = new FrickStore({ path: ":memory:", seed: false, schema: productTestSchema });
      try {
        const report = await restoreFrickDatabase({
          target,
          source: fromLines(withBadRows),
          confirm: "yes",
        });
        expect(report.skipped.length).toBeGreaterThanOrEqual(2);
        expect(report.skipped.some((s) => s.type === "<unparseable>")).toBe(true);
        expect(report.skipped.some((s) => s.type === "no_such_table")).toBe(true);
        expect(report.rowCountsByType.objects).toBe(1);
      } finally {
        target.close();
      }
    } finally {
      source.close();
    }
  });

  it("refuses a tenant-scoped restore row whose tenant_id does not match the header", async () => {
    const source = new FrickStore({ path: ":memory:", seed: false, schema: productTestSchema });
    try {
      await source.tenants.create("tenant-alpha");
      await source.upsertObject("tenant-alpha", "User", "user-alpha", { displayName: "Alpha" });
      const lines = await dumpToLines(source, "tenant-alpha");
      const mismatchedRow = JSON.stringify({
        type: "objects",
        row: {
          tenant_id: "tenant-beta",
          object_type: "User",
          object_id: "user-beta",
          version: 0,
          packed_base64: Buffer.from([1, 2, 3]).toString("base64"),
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      });
      const target = new FrickStore({ path: ":memory:", seed: false, schema: productTestSchema });
      try {
        await expect(
          restoreFrickDatabase({
            target,
            source: fromLines([lines[0]!, mismatchedRow, ...lines.slice(1)]),
            confirm: "yes",
          }),
        ).rejects.toMatchObject({ reason: "tenantScopeMismatch" });
        expect(await target.readObject("tenant-beta", "User", "user-beta")).toBeUndefined();
      } finally {
        target.close();
      }
    } finally {
      source.close();
    }
  });

  it("skips rows with columns outside the target table schema before insert SQL is built", async () => {
    const source = new FrickStore({ path: ":memory:", seed: false, schema: productTestSchema });
    try {
      await source.tenants.create("tenant-alpha");
      const lines = await dumpToLines(source, "tenant-alpha");
      const invalidRow = JSON.stringify({
        type: "objects",
        row: {
          tenant_id: "tenant-alpha",
          object_type: "User",
          object_id: "user-bad",
          version: 0,
          packed_base64: Buffer.from([1, 2, 3]).toString("base64"),
          updated_at: "2026-01-01T00:00:00.000Z",
          "object_id\") VALUES ('x'); DROP TABLE objects; --": "ignored",
        },
      });
      const target = new FrickStore({ path: ":memory:", seed: false, schema: productTestSchema });
      try {
        const report = await restoreFrickDatabase({
          target,
          source: fromLines([lines[0]!, invalidRow, ...lines.slice(1)]),
          confirm: "yes",
        });
        expect(report.skipped).toContainEqual(
          expect.objectContaining({
            type: "objects",
            reason:
              "invalidColumn: objects.object_id\") VALUES ('x'); DROP TABLE objects; --",
          }),
        );
        expect(await target.readObject("tenant-alpha", "User", "user-bad")).toBeUndefined();
        await target.upsertObject("tenant-alpha", "User", "user-ok", { displayName: "OK" });
        expect((await target.readObject("tenant-alpha", "User", "user-ok"))?.displayName).toBe("OK");
      } finally {
        target.close();
      }
    } finally {
      source.close();
    }
  });

  it("refuses without confirm:'yes'", async () => {
    const target = new FrickStore({ path: ":memory:", seed: false, schema: productTestSchema });
    try {
      await expect(
        restoreFrickDatabase({
          target,
          source: fromLines([]),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          confirm: "no" as any,
        }),
      ).rejects.toMatchObject({ reason: "missingConfirmation" });
    } finally {
      target.close();
    }
  });
});
