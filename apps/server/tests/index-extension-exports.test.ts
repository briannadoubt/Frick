import { describe, expect, it } from "vitest";
import {
  ALLOW,
  deny,
  type FrickAction,
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
  type Principal,
} from "../src/index.js";

// FR-113: the extension-authoring types referenced by `ServerOptions`
// (policyHooks + blobProcessors) must be importable straight from the
// package index, so apps can author hooks/processors without indexing into
// `ServerOptions[...]`. This test fails to compile if any export is dropped
// or renamed, and the runtime assertions cover the value exports.
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
});
