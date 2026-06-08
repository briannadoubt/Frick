import { describe, expect, it, vi } from "vitest";
import { createFrickPerAppRegistries } from "../src/apps/per-app-registries.js";
import { DEFAULT_APP_ID } from "../src/app-id.js";
import { DuplicateJobHandlerError, type FrickJobResult } from "../src/jobs/registry.js";
import type {
  FrickProjectionContext,
  FrickProjectionWriteEvent,
  ProjectionDeltaNotice,
} from "../src/projections/registry.js";

/**
 * FR-38: per-app handler / projection / job-worker registries. The server
 * previously shared one projection registry and one job registry across every
 * app it hosts, so app A's handlers ran against app B's writes/jobs. These
 * tests prove each app gets an independent registry set, while a single-app
 * server still has exactly one '_default' set and behaves identically.
 */

const fakeCtx = (): FrickProjectionContext =>
  ({
    tenantId: "_default",
    store: {} as never,
    logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never,
  }) as FrickProjectionContext;

const objectUpsert = (type: string): FrickProjectionWriteEvent => ({
  kind: "objectUpsert",
  tenantId: "_default",
  objectType: type,
  objectId: "x",
  object: { id: "x" },
});

describe("createFrickPerAppRegistries (FR-38)", () => {
  it("returns the same set for the same appId and distinct sets per app", () => {
    const reg = createFrickPerAppRegistries();
    const a1 = reg.for("app-a");
    const a2 = reg.for("app-a");
    const b = reg.for("app-b");

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1.projections).not.toBe(b.projections);
    expect(a1.jobs).not.toBe(b.jobs);
    expect(a1.appId).toBe("app-a");
    expect(b.appId).toBe("app-b");
  });

  it("eagerly creates the default set; '' and undefined map to it", () => {
    const reg = createFrickPerAppRegistries();
    expect(reg.has(DEFAULT_APP_ID)).toBe(true);
    expect(reg.for()).toBe(reg.for(DEFAULT_APP_ID));
    expect(reg.for("")).toBe(reg.for(DEFAULT_APP_ID));
    // A fresh single-app server has exactly one set until another app is used.
    expect(reg.appIds()).toEqual([DEFAULT_APP_ID]);
  });

  it("isolates projections: app A's handler never fires on app B's writes", async () => {
    const reg = createFrickPerAppRegistries();

    const aApplied: string[] = [];
    const bApplied: string[] = [];

    reg.for("app-a").projections.register({
      name: "conv-view",
      sources: [{ kind: "object", type: "Conversation" }],
      handler: {
        apply: (e) => {
          aApplied.push(e.objectType!);
        },
      },
    });
    reg.for("app-b").projections.register({
      name: "conv-view",
      sources: [{ kind: "object", type: "Conversation" }],
      handler: {
        apply: (e) => {
          bApplied.push(e.objectType!);
        },
      },
    });

    // A write routed to app B notifies only B's registry.
    await reg.for("app-b").projections.notify(objectUpsert("Conversation"), fakeCtx());
    expect(bApplied).toEqual(["Conversation"]);
    expect(aApplied).toEqual([]);

    // ...and vice versa. The shared projection *name* does not collide because
    // each app owns its own registry instance.
    await reg.for("app-a").projections.notify(objectUpsert("Conversation"), fakeCtx());
    expect(aApplied).toEqual(["Conversation"]);
    expect(bApplied).toEqual(["Conversation"]);
  });

  it("isolates job handlers: a handler registered for app A does not resolve in app B", () => {
    const reg = createFrickPerAppRegistries();

    const handlerA = async (): Promise<FrickJobResult> => ({ status: "completed" });
    reg.for("app-a").jobs.register("sendEmail", handlerA);

    expect(reg.for("app-a").jobs.resolve("sendEmail")).toBe(handlerA);
    // Same job type, different app: not registered there.
    expect(reg.for("app-b").jobs.resolve("sendEmail")).toBeUndefined();

    // Each app may register its OWN handler for the same job type without the
    // duplicate-registration guard tripping across apps.
    const handlerB = async (): Promise<FrickJobResult> => ({ status: "completed" });
    expect(() => reg.for("app-b").jobs.register("sendEmail", handlerB)).not.toThrow();
    expect(reg.for("app-b").jobs.resolve("sendEmail")).toBe(handlerB);

    // ...but a duplicate WITHIN one app still throws (the per-registry guard is intact).
    expect(() => reg.for("app-a").jobs.register("sendEmail", handlerA)).toThrow(
      DuplicateJobHandlerError,
    );
  });

  it("routes projection deltas to the originating app's listener only", async () => {
    const aListener = vi.fn<(n: ProjectionDeltaNotice) => void>();
    const bListener = vi.fn<(n: ProjectionDeltaNotice) => void>();
    const reg = createFrickPerAppRegistries({
      projectionDeltaListenerFor: (appId) =>
        appId === "app-a" ? aListener : appId === "app-b" ? bListener : undefined,
    });

    const register = (appId: string) =>
      reg.for(appId).projections.register({
        name: "feed",
        sources: [{ kind: "object", type: "Post" }],
        handler: {
          apply: () => ({ changes: [{ key: "k", value: { id: "k" } }] }),
        },
      });
    register("app-a");
    register("app-b");

    await reg.for("app-a").projections.notify(objectUpsert("Post"), fakeCtx());

    expect(aListener).toHaveBeenCalledTimes(1);
    expect(aListener.mock.calls[0]![0].projection).toBe("feed");
    expect(bListener).not.toHaveBeenCalled();
  });
});
