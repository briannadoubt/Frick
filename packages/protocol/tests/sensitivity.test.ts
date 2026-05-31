import { describe, expect, it } from "vitest";
import {
  DEFAULT_FIELD_SENSITIVITY,
  DEFAULT_REDACTED_SENSITIVITIES,
  REDACTED_FIELD_VALUE,
  fieldSensitivityMap,
  redactRecord,
  redactRecords,
  resolveFieldSensitivity,
  shouldRedactSensitivity,
  validateSchema,
  type FieldDef,
  type FrickSchema,
} from "../src/index.js";

const baseSchema = (fields: FieldDef[]): FrickSchema => ({
  name: "frick-sensitivity-test",
  schemaId: "frick-sensitivity-test",
  schemaVersion: "0.1.0",
  schemaRevision: 1,
  minimumClientRevision: 1,
  minimumServerRevision: 1,
  protocol: "frick.realtime",
  protocolVersion: 1,
  compatibility: "greenfield-cutover",
  hash: "frick-sensitivity-test-0.1.0",
  objects: [
    {
      id: 1,
      name: "Account",
      fields,
      indexes: [],
    },
  ],
  streams: [],
  events: [],
  presences: [],
  signals: [],
  blobs: [],
  jobs: [],
  projections: [],
});

const accountFields: FieldDef[] = [
  { id: 1, name: "handle", kind: "string", required: true, sensitivity: "public" },
  { id: 2, name: "email", kind: "string", required: true, sensitivity: "pii" },
  { id: 3, name: "apiToken", kind: "string", required: false, sensitivity: "secret" },
  { id: 4, name: "messageBody", kind: "string", required: false, sensitivity: "content" },
  { id: 5, name: "internalNote", kind: "string", required: false }, // default -> private
];

describe("field sensitivity classification", () => {
  it("round-trips the sensitivity annotation through schema validation", () => {
    const schema = validateSchema(baseSchema(accountFields));
    const fields = schema.objects[0]!.fields;

    expect(fields.find((f) => f.name === "handle")?.sensitivity).toBe("public");
    expect(fields.find((f) => f.name === "email")?.sensitivity).toBe("pii");
    expect(fields.find((f) => f.name === "apiToken")?.sensitivity).toBe("secret");
    expect(fields.find((f) => f.name === "messageBody")?.sensitivity).toBe("content");
  });

  it("leaves un-annotated fields without an explicit sensitivity (backward compatible)", () => {
    const schema = validateSchema(baseSchema(accountFields));
    const internalNote = schema.objects[0]!.fields.find((f) => f.name === "internalNote");

    expect(internalNote).toBeDefined();
    expect(internalNote!.sensitivity).toBeUndefined();
  });

  it("defaults un-annotated fields to the conservative classification", () => {
    expect(DEFAULT_FIELD_SENSITIVITY).toBe("private");
    expect(resolveFieldSensitivity({})).toBe("private");
    expect(resolveFieldSensitivity({ sensitivity: "public" })).toBe("public");
  });

  it("rejects an unknown sensitivity value during validation", () => {
    const broken = baseSchema([
      // @ts-expect-error intentionally invalid classification
      { id: 1, name: "handle", kind: "string", required: true, sensitivity: "topsecret" },
    ]);

    expect(() => validateSchema(broken)).toThrow(/Unknown sensitivity/);
  });

  it("builds a name -> effective sensitivity map honoring the default", () => {
    const map = fieldSensitivityMap(accountFields);

    expect(map.get("handle")).toBe("public");
    expect(map.get("email")).toBe("pii");
    expect(map.get("internalNote")).toBe("private");
  });
});

describe("redactRecord", () => {
  const record = {
    handle: "ada",
    email: "ada@example.com",
    apiToken: "tok_live_123",
    messageBody: "secret meeting at noon",
    internalNote: "kept as-is",
    unknownField: "no field def",
  };

  it("masks secret and pii values while leaving public values intact", () => {
    const redacted = redactRecord(record, accountFields);

    expect(redacted.handle).toBe("ada"); // public passes through
    expect(redacted.email).toBe(REDACTED_FIELD_VALUE); // pii masked
    expect(redacted.apiToken).toBe(REDACTED_FIELD_VALUE); // secret masked
  });

  it("masks content by default but leaves private (default) fields untouched", () => {
    const redacted = redactRecord(record, accountFields);

    expect(redacted.messageBody).toBe(REDACTED_FIELD_VALUE); // content masked
    expect(redacted.internalNote).toBe("kept as-is"); // private default not masked
  });

  it("treats fields with no definition as the default classification (not masked)", () => {
    const redacted = redactRecord(record, accountFields);
    expect(redacted.unknownField).toBe("no field def");
  });

  it("does not mutate the source record", () => {
    const copy = { ...record };
    redactRecord(record, accountFields);
    expect(record).toEqual(copy);
  });

  it("honors a custom redaction set", () => {
    const redacted = redactRecord(record, accountFields, { redact: ["secret"] });

    expect(redacted.apiToken).toBe(REDACTED_FIELD_VALUE);
    expect(redacted.email).toBe("ada@example.com"); // pii not in custom set
    expect(redacted.messageBody).toBe("secret meeting at noon"); // content not in custom set
  });

  it("supports a custom placeholder", () => {
    const redacted = redactRecord(record, accountFields, { placeholder: null });
    expect(redacted.email).toBeNull();
  });

  it("exposes the default redaction set and a sensitivity predicate", () => {
    expect(DEFAULT_REDACTED_SENSITIVITIES).toEqual(["pii", "secret", "content"]);
    expect(shouldRedactSensitivity("secret")).toBe(true);
    expect(shouldRedactSensitivity("public")).toBe(false);
    expect(shouldRedactSensitivity("private")).toBe(false);
  });
});

describe("redactRecords", () => {
  it("redacts every record in a list", () => {
    const rows = [
      { handle: "ada", apiToken: "tok-1" },
      { handle: "grace", apiToken: "tok-2" },
    ];
    const redacted = redactRecords(rows, accountFields);

    expect(redacted.map((r) => r.handle)).toEqual(["ada", "grace"]);
    expect(redacted.map((r) => r.apiToken)).toEqual([
      REDACTED_FIELD_VALUE,
      REDACTED_FIELD_VALUE,
    ]);
  });
});
