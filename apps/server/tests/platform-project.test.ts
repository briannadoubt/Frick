import { describe, expect, it } from "vitest";
import { foundationSchema } from "@frick/protocol";
import {
  createFrickProjectModule,
  projectModuleToAppDefinition,
} from "../src/platform/project.js";

describe("Frick project module contract", () => {
  it("normalizes a valid project module", () => {
    const project = createFrickProjectModule({
      manifest: {
        id: "crm",
        name: "crm",
        version: "0.1.0",
        displayName: "CRM",
      },
      schema: foundationSchema,
    });

    expect(project.manifest).toEqual({
      id: "crm",
      name: "crm",
      version: "0.1.0",
      displayName: "CRM",
    });
    expect(project.schema.schemaId).toBe(foundationSchema.schemaId);
  });

  it("rejects invalid project ids before the server boots", () => {
    expect(() =>
      createFrickProjectModule({
        manifest: { id: "Bad Project!", name: "bad" },
        schema: foundationSchema,
      }),
    ).toThrow(/manifest.id/);
  });

  it("validates the supplied schema", () => {
    expect(() =>
      createFrickProjectModule({
        manifest: { id: "broken", name: "broken" },
        schema: { ...foundationSchema, protocol: "nope" as "frick.realtime" },
      }),
    ).toThrow(/Unsupported protocol/);
  });

  it("can convert a project into the root app definition", () => {
    const project = createFrickProjectModule({
      manifest: { id: "crm", name: "crm" },
      schema: foundationSchema,
    });

    expect(projectModuleToAppDefinition(project)).toMatchObject({
      id: "crm",
      basePath: "",
      schema: foundationSchema,
    });
  });
});
