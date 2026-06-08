import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { productTestSchema } from "@fricken/protocol";
import { initializeStorage } from "../src/storage/schema.js";
import { SqliteSqlDriver } from "../src/storage/sql-driver.js";
import { ObjectStore } from "../src/storage/object-store.js";
import { StreamStore } from "../src/storage/stream-store.js";
import { FrickCrossAppAccessError } from "../src/storage/object-errors.js";
import { createFrickPerAppRegistries } from "../src/apps/per-app-registries.js";
import type {
  FrickProjectionContext,
  FrickProjectionWriteEvent,
} from "../src/projections/registry.js";
import type { FrickJobResult } from "../src/jobs/registry.js";

/**
 * FR-40 — cross-app / cross-tenant isolation proof suite (FR-6 epic).
 *
 * The single focused suite that proves the epic works: no data, handler, or
 * job leakage across apps OR tenants. It exercises BOTH partitioning axes
 * together — `app_id` (FR-36 schema, FR-37 query threading) and `tenant_id`
 * (the pre-existing boundary) — over objects, streams, idempotency,
 * projections, and job handlers (FR-38 per-app registries).
 *
 * Where FR-37/FR-38 each prove a single axis in isolation, this suite proves
 * the *matrix*: an app+tenant pair sees only its own rows, a different app OR
 * a different tenant sees nothing, and per-app registries never cross-fire.
 */

let db: DatabaseSync | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function makeDriver(): SqliteSqlDriver {
  db = new DatabaseSync(":memory:");
  initializeStorage(db, productTestSchema.schemaRevision);
  return new SqliteSqlDriver(db);
}

const TYPE = "Conversation";

// The four corners of the (app, tenant) matrix.
const CELLS = [
  { app: "app-a", tenant: "tenant-1", label: "A1" },
  { app: "app-a", tenant: "tenant-2", label: "A2" },
  { app: "app-b", tenant: "tenant-1", label: "B1" },
  { app: "app-b", tenant: "tenant-2", label: "B2" },
] as const;

describe("FR-40 cross-app/cross-tenant isolation — objects", () => {
  it("each (app, tenant) cell reads back only its own object and none of the others", async () => {
    const store = new ObjectStore(makeDriver(), productTestSchema);

    // The objects PRIMARY KEY is (tenant_id, object_type, object_id) — app_id
    // is additive, not in the key — so two apps in the SAME tenant cannot share
    // an object id (that PK-collision is rejected; see the dedicated test
    // below). A valid matrix gives each cell its own id; isolation then means a
    // read in one cell never sees ANOTHER cell's id even when probed with a
    // foreign (app, tenant).
    const id = (c: (typeof CELLS)[number]) => `obj-${c.label}`;
    for (const c of CELLS) {
      await store.upsert(c.tenant, TYPE, id(c), { id: id(c), title: c.label }, 1, c.app);
    }

    for (const self of CELLS) {
      // Own read succeeds.
      expect(await store.read(self.tenant, TYPE, id(self), self.app)).toMatchObject({
        title: self.label,
      });
      // No OTHER cell can see this id — neither a different app at the same
      // tenant, nor the same app at a different tenant, nor the default cell.
      for (const other of CELLS) {
        if (other.label === self.label) continue;
        expect(
          await store.read(other.tenant, TYPE, id(self), other.app),
          `${other.label} must not read ${self.label}'s object`,
        ).toBeUndefined();
      }
      expect(await store.read(self.tenant, TYPE, id(self))).toBeUndefined(); // default app
      expect(await store.read("_default", TYPE, id(self), self.app)).toBeUndefined(); // default tenant
    }
  });

  it("a list in one cell never includes another app's or tenant's objects", async () => {
    const store = new ObjectStore(makeDriver(), productTestSchema);
    for (const c of CELLS) {
      await store.upsert(c.tenant, TYPE, `obj-${c.label}`, { id: `obj-${c.label}` }, 1, c.app);
    }
    for (const c of CELLS) {
      const ids = (await store.list(c.tenant, TYPE, c.app)).map((o) => o.id);
      expect(ids).toEqual([`obj-${c.label}`]);
    }
  });

  it("a cross-app write to another app's row in the same tenant is rejected", async () => {
    const store = new ObjectStore(makeDriver(), productTestSchema);
    await store.upsert("tenant-1", TYPE, "shared-id", { id: "shared-id", title: "A1" }, 1, "app-a");
    // Same tenant, same id, different app: denied (objects PK is tenant+type+id).
    await expect(
      store.upsert("tenant-1", TYPE, "shared-id", { id: "shared-id", title: "hijack" }, 2, "app-b"),
    ).rejects.toBeInstanceOf(FrickCrossAppAccessError);
    // The owner's row is intact.
    expect(await store.read("tenant-1", TYPE, "shared-id", "app-a")).toMatchObject({ title: "A1" });
  });
});

describe("FR-40 cross-app/cross-tenant isolation — streams", () => {
  const STREAM = "MessageStream";

  async function append(store: StreamStore, app: string, tenant: string, body: string) {
    return store.append({
      appId: app,
      tenantId: tenant,
      stream: STREAM,
      streamId: "room",
      replicaId: "r1",
      requestId: `${app}-${tenant}-${body}`,
      event: "MessageSent",
      payload: { messageId: `m-${body}`, senderId: "u", body, createdAt: "2026-05-31T00:00:00.000Z" },
    });
  }

  it("each (app, tenant) cell reads only its own events on a shared stream id", async () => {
    const store = new StreamStore(makeDriver(), productTestSchema);
    for (const c of CELLS) {
      await append(store, c.app, c.tenant, c.label);
    }
    for (const c of CELLS) {
      const events = await store.read(c.tenant, STREAM, "room", 0, undefined, c.app);
      expect(events).toHaveLength(1);
      expect((events[0]!.payload as { body: string }).body).toBe(c.label);
      expect(events[0]!.appId).toBe(c.app);
      expect(events[0]!.tenantId).toBe(c.tenant);
    }
    // Default cell sees nothing.
    expect(await store.read("tenant-1", STREAM, "room", 0)).toHaveLength(0);
  });

  it("listAll is scoped to the (app, tenant) cell", async () => {
    const store = new StreamStore(makeDriver(), productTestSchema);
    for (const c of CELLS) {
      await append(store, c.app, c.tenant, c.label);
    }
    for (const c of CELLS) {
      const all = await store.listAll(c.tenant, c.app);
      expect(all).toHaveLength(1);
      expect((all[0]!.payload as { body: string }).body).toBe(c.label);
    }
  });
});

describe("FR-40 cross-app/cross-tenant isolation — projections & jobs", () => {
  const ctx = (tenantId: string): FrickProjectionContext =>
    ({
      tenantId,
      store: {} as never,
      logger: { warn() {}, info() {}, error() {}, debug() {} } as never,
    }) as FrickProjectionContext;

  const upsert = (tenantId: string): FrickProjectionWriteEvent => ({
    kind: "objectUpsert",
    tenantId,
    objectType: TYPE,
    objectId: "x",
    object: { id: "x" },
  });

  it("a projection registered in app A never fires for a write routed to app B", async () => {
    const reg = createFrickPerAppRegistries();
    const fired: Array<{ app: string; tenant: string }> = [];

    for (const app of ["app-a", "app-b"]) {
      reg.for(app).projections.register({
        name: "view",
        sources: [{ kind: "object", type: TYPE }],
        handler: { apply: (e) => void fired.push({ app, tenant: e.tenantId }) },
      });
    }

    // Route a write to app-a / tenant-1 only.
    await reg.for("app-a").projections.notify(upsert("tenant-1"), ctx("tenant-1"));
    expect(fired).toEqual([{ app: "app-a", tenant: "tenant-1" }]);

    // Route a write to app-b / tenant-2: only app-b's handler fires.
    await reg.for("app-b").projections.notify(upsert("tenant-2"), ctx("tenant-2"));
    expect(fired).toEqual([
      { app: "app-a", tenant: "tenant-1" },
      { app: "app-b", tenant: "tenant-2" },
    ]);
  });

  it("projection snapshots are tenant-scoped within an app and never cross apps", async () => {
    const reg = createFrickPerAppRegistries();
    for (const app of ["app-a", "app-b"]) {
      reg.for(app).projections.register({
        name: "feed",
        sources: [{ kind: "object", type: TYPE }],
        handler: {
          apply: (e) => ({ changes: [{ key: `${e.tenantId}:row`, value: { id: "row", app } }] }),
        },
      });
    }

    await reg.for("app-a").projections.notify(upsert("tenant-1"), ctx("tenant-1"));
    await reg.for("app-a").projections.notify(upsert("tenant-2"), ctx("tenant-2"));
    await reg.for("app-b").projections.notify(upsert("tenant-1"), ctx("tenant-1"));

    // app-a's tenant-1 snapshot holds only its row; tenant-2 is separate.
    const a1 = reg.for("app-a").projections.snapshot("feed", "tenant-1");
    expect(a1).toHaveLength(1);
    expect(a1[0]!.value).toMatchObject({ app: "app-a" });

    // app-b's tenant-1 snapshot is a different registry instance entirely.
    const b1 = reg.for("app-b").projections.snapshot("feed", "tenant-1");
    expect(b1).toHaveLength(1);
    expect(b1[0]!.value).toMatchObject({ app: "app-b" });

    // app-a has no tenant-3 rows, and app-b never saw tenant-2.
    expect(reg.for("app-a").projections.snapshot("feed", "tenant-3")).toEqual([]);
    expect(reg.for("app-b").projections.snapshot("feed", "tenant-2")).toEqual([]);
  });

  it("a job handler registered for app A does not resolve in app B", () => {
    const reg = createFrickPerAppRegistries();
    const handlerA = async (): Promise<FrickJobResult> => ({ status: "completed" });
    reg.for("app-a").jobs.register("derive", handlerA);

    expect(reg.for("app-a").jobs.resolve("derive")).toBe(handlerA);
    expect(reg.for("app-b").jobs.resolve("derive")).toBeUndefined();
    expect(reg.for("app-a").jobs.list()).toEqual(["derive"]);
    expect(reg.for("app-b").jobs.list()).toEqual([]);
  });
});
