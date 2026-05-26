import { describe, expect, it } from "vitest";
import {
  productTestSchema,
  lintSchema,
  lintSchemaChange,
  type FrickSchema,
} from "../src/index.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("lintSchemaChange", () => {
  it("returns no findings for an identical schema", () => {
    const result = lintSchemaChange(productTestSchema, productTestSchema);
    expect(result.breakingCount).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("flags object removal as breaking", () => {
    const next = clone(productTestSchema) as FrickSchema;
    next.objects = next.objects.filter((o) => o.name !== "Conversation");
    const result = lintSchemaChange(next, productTestSchema);
    const removed = result.findings.find((f) => f.ruleId === "object.removed");
    expect(removed).toBeDefined();
    expect(removed?.severity).toBe("breaking");
    expect(result.breakingCount).toBeGreaterThanOrEqual(1);
  });

  it("flags adding a required field as breaking", () => {
    const next = clone(productTestSchema) as FrickSchema;
    const user = next.objects.find((o) => o.name === "User")!;
    const nextFieldId = Math.max(...user.fields.map((f) => f.id)) + 1;
    user.fields.push({
      id: nextFieldId,
      name: "newRequired",
      kind: "string",
      required: true,
    });
    const result = lintSchemaChange(next, productTestSchema);
    const finding = result.findings.find(
      (f) => f.ruleId === "field.required.added",
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("breaking");
  });

  it("flags adding an optional field as info", () => {
    const next = clone(productTestSchema) as FrickSchema;
    const user = next.objects.find((o) => o.name === "User")!;
    const nextFieldId = Math.max(...user.fields.map((f) => f.id)) + 1;
    user.fields.push({
      id: nextFieldId,
      name: "nickname",
      kind: "string",
      required: false,
    });
    const result = lintSchemaChange(next, productTestSchema);
    const finding = result.findings.find(
      (f) => f.ruleId === "field.optional.added",
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("info");
    expect(result.breakingCount).toBe(0);
  });

  it("flags decreasing schemaRevision as breaking", () => {
    const previous = clone(productTestSchema) as FrickSchema;
    previous.schemaRevision = 5;
    const next = clone(productTestSchema) as FrickSchema;
    next.schemaRevision = 4;
    const result = lintSchemaChange(next, previous);
    const finding = result.findings.find(
      (f) => f.ruleId === "schema.revision.decreased",
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("breaking");
  });

  it("flags renaming a field at the same id as breaking", () => {
    const next = clone(productTestSchema) as FrickSchema;
    const user = next.objects.find((o) => o.name === "User")!;
    user.fields[0]!.name = `${user.fields[0]!.name}Renamed`;
    const result = lintSchemaChange(next, productTestSchema);
    const finding = result.findings.find((f) => f.ruleId === "field.renamed");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("breaking");
  });

  it("flags schemaId change as breaking", () => {
    const next = clone(productTestSchema) as FrickSchema;
    next.schemaId = "different";
    const result = lintSchemaChange(next, productTestSchema);
    expect(
      result.findings.find((f) => f.ruleId === "schema.id.changed"),
    ).toBeDefined();
    expect(result.breakingCount).toBeGreaterThanOrEqual(1);
  });

  it("warns on minimumClientRevision raised", () => {
    const next = clone(productTestSchema) as FrickSchema;
    next.minimumClientRevision = productTestSchema.minimumClientRevision + 1;
    const result = lintSchemaChange(next, productTestSchema);
    const finding = result.findings.find(
      (f) => f.ruleId === "schema.minimumClientRevision.raised",
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warn");
    expect(result.breakingCount).toBe(0);
  });

  it("flags field kind change as breaking", () => {
    const next = clone(productTestSchema) as FrickSchema;
    const user = next.objects.find((o) => o.name === "User")!;
    const target = user.fields.find((f) => f.kind === "string");
    if (target) {
      target.kind = "int";
    }
    const result = lintSchemaChange(next, productTestSchema);
    expect(
      result.findings.find((f) => f.ruleId === "field.kind.changed"),
    ).toBeDefined();
  });
});

describe("lintSchema", () => {
  it("returns no findings on the foundation schema", () => {
    const result = lintSchema(productTestSchema);
    expect(result.findings).toEqual([]);
    expect(result.breakingCount).toBe(0);
  });

  it("flags duplicate object names", () => {
    const broken = clone(productTestSchema) as FrickSchema;
    const first = broken.objects[0]!;
    broken.objects.push({ ...first, id: 9999, fields: first.fields.map((f) => ({ ...f })) });
    const result = lintSchema(broken);
    expect(
      result.findings.find((f) => f.ruleId === "object.duplicate.name"),
    ).toBeDefined();
    expect(result.breakingCount).toBeGreaterThanOrEqual(1);
  });
});
