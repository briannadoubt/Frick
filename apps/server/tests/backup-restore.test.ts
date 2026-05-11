import { describe, expect, it } from "vitest";
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
    const source = new FrickStore({ path: ":memory:", seed: false });
    try {
      source.tenants.create("tenant-alpha");
      source.upsertObject("tenant-alpha", "User", "user-ada", { displayName: "Ada" });
      source.appendEvent({
        tenantId: "tenant-alpha",
        requestId: "req-1",
        replicaId: "replica-1",
        stream: "MessageStream",
        streamId: "conversation-1",
        event: "MessageSent",
        payload: { body: "hello" },
      });

      const lines = await dumpToLines(source, "tenant-alpha");
      const target = new FrickStore({ path: ":memory:", seed: false });
      try {
        const report = await restoreFrickDatabase({
          target,
          source: fromLines(lines),
          confirm: "yes",
        });
        expect(report.rowCountsByType.objects).toBe(1);
        expect(report.rowCountsByType.stream_events).toBe(1);
        expect(report.schemaCompatibility.matched).toBe(true);
        expect(target.readObject("tenant-alpha", "User", "user-ada")?.displayName).toBe(
          "Ada",
        );
        const events = target.readEvents("tenant-alpha", "MessageStream", "conversation-1", 0);
        expect(events).toHaveLength(1);
        expect(events[0]!.event).toBe("MessageSent");
      } finally {
        target.close();
      }
    } finally {
      source.close();
    }
  });

  it("refuses to restore over a non-empty target without overwrite", async () => {
    const source = new FrickStore({ path: ":memory:", seed: false });
    const target = new FrickStore({ path: ":memory:" });
    try {
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
    const source = new FrickStore({ path: ":memory:", seed: false });
    const target = new FrickStore({ path: ":memory:", seed: false });
    try {
      source.upsertObject("_default", "User", "user-source", { displayName: "Source" });
      target.upsertObject("_default", "User", "user-stale", { displayName: "Stale" });
      const lines = await dumpToLines(source, "_default");
      const report = await restoreFrickDatabase({
        target,
        source: fromLines(lines),
        confirm: "yes",
        overwrite: true,
      });
      expect(report.rowCountsByType.objects).toBe(1);
      expect(target.readObject("_default", "User", "user-stale")).toBeUndefined();
      expect(target.readObject("_default", "User", "user-source")?.displayName).toBe("Source");
    } finally {
      source.close();
      target.close();
    }
  });

  it("refuses on schema hash mismatch unless forceSchemaDrift", async () => {
    const source = new FrickStore({ path: ":memory:", seed: false });
    try {
      const lines = await dumpToLines(source, "_default");
      // Mutate the header schemaHash to simulate drift.
      const header = JSON.parse(lines[0]!) as { type: string; row: { schemaHash: string } };
      header.row.schemaHash = "00000000000000000000000000000000000000000000000000000000";
      const mutated = [JSON.stringify(header), ...lines.slice(1)];

      const target = new FrickStore({ path: ":memory:", seed: false });
      try {
        await expect(
          restoreFrickDatabase({
            target,
            source: fromLines(mutated),
            confirm: "yes",
          }),
        ).rejects.toMatchObject({ reason: "schemaHashMismatch" });

        const target2 = new FrickStore({ path: ":memory:", seed: false });
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
    const source = new FrickStore({ path: ":memory:", seed: false });
    try {
      source.upsertObject("_default", "User", "user-ok", { displayName: "OK" });
      const lines = await dumpToLines(source, "_default");
      // Inject one malformed row plus one row with an unknown table type.
      const withBadRows = [
        lines[0]!,
        "not-json-at-all",
        JSON.stringify({ type: "no_such_table", row: { tenant_id: "_default" } }),
        ...lines.slice(1),
      ];
      const target = new FrickStore({ path: ":memory:", seed: false });
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

  it("refuses without confirm:'yes'", async () => {
    const target = new FrickStore({ path: ":memory:", seed: false });
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
