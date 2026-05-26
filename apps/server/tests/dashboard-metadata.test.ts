import { describe, expect, it } from "vitest";
import { productTestSchema } from "@frick/protocol";
import { createFrickAppRegistry } from "../src/apps/registry.js";
import { buildDashboardMetadata } from "../src/dashboard/metadata.js";
import { createFrickProjectModule } from "../src/platform/project.js";

describe("dashboard metadata", () => {
  it("summarizes project identity and schema resources", () => {
    const project = createFrickProjectModule({
      manifest: { id: "foundation", name: "foundation", displayName: "Foundation" },
      schema: productTestSchema,
    });
    const appRegistry = createFrickAppRegistry([
      { id: "foundation", basePath: "", schema: productTestSchema },
    ]);

    const metadata = buildDashboardMetadata({ project, appRegistry });

    expect(metadata.project).toMatchObject({
      id: "foundation",
      name: "foundation",
      displayName: "Foundation",
      schemaId: productTestSchema.schemaId,
      schemaVersion: productTestSchema.schemaVersion,
      schemaRevision: productTestSchema.schemaRevision,
      schemaHash: productTestSchema.hash,
    });
    expect(metadata.resources).toContainEqual({
      kind: "object",
      name: "User",
      fieldCount: 2,
      indexCount: 1,
    });
    expect(metadata.resources).toContainEqual({
      kind: "stream",
      name: "MessageStream",
      fieldCount: 1,
    });
    expect(metadata.apps).toEqual([
      {
        id: "foundation",
        basePath: "",
        schemaId: productTestSchema.schemaId,
        schemaRevision: productTestSchema.schemaRevision,
      },
    ]);
  });
});
