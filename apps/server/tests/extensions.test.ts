import { describe, expect, it } from "vitest";
import {
  createFrickExtensionRegistry,
  type FrickExtensionRegistryInput,
} from "../src/extensions.js";

describe("frick extension registry", () => {
  it("creates empty extension groups by default", () => {
    expect(createFrickExtensionRegistry()).toEqual({
      policies: [],
      projections: [],
      jobs: [],
      blobProcessors: [],
      searchAdapters: [],
      notificationIntents: [],
      observabilityHooks: [],
    });
  });

  it("normalizes provided extension groups without sharing mutable arrays", () => {
    const input: FrickExtensionRegistryInput = {
      policies: [{ id: "policy.test" }],
      projections: [{ id: "projection.test" }],
    };

    const registry = createFrickExtensionRegistry(input);
    input.policies?.push({ id: "policy.mutated" });

    expect(registry.policies).toEqual([{ id: "policy.test" }]);
    expect(registry.projections).toEqual([{ id: "projection.test" }]);
    expect(registry.jobs).toEqual([]);
  });
});
