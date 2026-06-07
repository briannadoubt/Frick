import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ALLOW,
  deny,
  type FrickAction,
  type FrickAppRoute,
  type FrickBlobProcessContext,
  type FrickBlobProcessResult,
  type FrickBlobProcessor,
  type FrickBlobProcessorRegistry,
  type FrickBlobValidateContext,
  type FrickBlobValidationResult,
  type FrickDecision,
  type FrickDecisionReason,
  type FrickPolicyHook,
  type FrickPolicyInput,
  type FrickProjection,
  type FrickProjectionContext,
  type FrickProjectionHandler,
  type FrickProjectionWriteEvent,
  type Principal,
  type ProjectionApplyResult,
  type ProjectionChange,
} from "../src/index.js";

// FR-113: the extension-authoring types referenced by `ServerOptions`
// (policyHooks + blobProcessors) must be importable straight from the
// package index, so apps can author hooks/processors without indexing into
// `ServerOptions[...]`. This test fails to compile if any export is dropped
// or renamed, and the runtime assertions cover the value exports.
//
// FR-129 extends this to the remaining extension-authoring surfaces apps were
// reverse-engineering out of `ServerOptions` (projections + app routes), so
// every type an app author needs is importable directly from the index.
describe("@fricken/server index extension-authoring exports", () => {
  it("re-exports the authz value symbols", () => {
    expect(ALLOW).toEqual({ allow: true, reason: "allow" });
    expect(typeof deny).toBe("function");
    expect(deny("ownerMismatch", "nope")).toEqual({
      allow: false,
      reason: "ownerMismatch",
      publicMessage: "nope",
    });
  });

  it("re-exports the authz types usable to author a policy hook", () => {
    const principal: Principal = {
      userId: "u",
      deviceId: "d",
      replicaId: "r",
      tenantId: "t",
    };
    const action: FrickAction = "object.read";
    const reason: FrickDecisionReason = "allow";
    const input: FrickPolicyInput = {
      principal,
      action,
      resource: { kind: "object", name: "Note", key: "n1" },
    };
    const hook: FrickPolicyHook = (i: FrickPolicyInput): FrickDecision | null =>
      i.principal ? ALLOW : deny("unauthenticated", "no");
    expect(hook(input)).toEqual(ALLOW);
    expect(reason).toBe("allow");
  });

  it("re-exports the blob-processor types usable to author a processor", () => {
    const processor: FrickBlobProcessor = {
      id: "noop",
      matches: {},
      async validate(_ctx: FrickBlobValidateContext): Promise<FrickBlobValidationResult> {
        return { ok: true };
      },
      async process(_ctx: FrickBlobProcessContext): Promise<FrickBlobProcessResult> {
        return {};
      },
    };
    const collect = (registry: FrickBlobProcessorRegistry): string[] =>
      registry.list().map((p) => p.id);
    expect(processor.id).toBe("noop");
    expect(typeof collect).toBe("function");
  });

  it("re-exports the projection types usable to author a projection (FR-129)", () => {
    // Mirrors what an app author writes for `ServerOptions.projections`,
    // proving they no longer need to derive the apply ctx / change types out
    // of `NonNullable<ServerOptions["projections"]>[number]`.
    const handler: FrickProjectionHandler = {
      apply(_event: FrickProjectionWriteEvent, _ctx: FrickProjectionContext): ProjectionApplyResult {
        const change: ProjectionChange = { key: "user-1:conv-1", value: { unread: 1 } };
        return { changes: [change] };
      },
    };
    const projection: FrickProjection = {
      name: "unread-counts",
      sources: [{ kind: "object", type: "Conversation" }],
      handler,
    };
    expect(projection.name).toBe("unread-counts");
    const result = projection.handler.apply(
      {} as FrickProjectionWriteEvent,
      {} as FrickProjectionContext,
    );
    expect(result).toEqual({ changes: [{ key: "user-1:conv-1", value: { unread: 1 } }] });
  });

  it("re-exports FrickAppRoute usable to author an app route (FR-129)", () => {
    // App routes get raw node http req/res; the only Frick-specific type is
    // the route descriptor itself, which must be importable from the index.
    const route: FrickAppRoute = {
      pathPrefix: "/api/widgets",
      method: "GET",
      handle(_req: IncomingMessage, _res: ServerResponse): boolean {
        return false;
      },
    };
    expect(route.pathPrefix).toBe("/api/widgets");
    expect(route.handle({} as IncomingMessage, {} as ServerResponse)).toBe(false);
  });
});
