import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FrameKind,
  foundationSchema,
  isFrickErrorEnvelope,
  type FrickFrame,
} from "../src/index.js";

const fixturesDir = join(process.cwd(), "packages/protocol/fixtures");

describe("protocol fixtures", () => {
  it("writes foundation schema metadata fixture", () => {
    const fixture = readJson("foundation-schema.json") as typeof foundationSchema;

    expect(fixture.schemaId).toBe(foundationSchema.schemaId);
    expect(fixture.schemaRevision).toBe(foundationSchema.schemaRevision);
    expect(fixture.hash).toBe(foundationSchema.hash);
  });

  it("writes shared error envelope fixture", () => {
    const fixture = readJson("error-envelope.json");

    expect(isFrickErrorEnvelope(fixture)).toBe(true);
    expect(fixture).toMatchObject({
      code: "schema.incompatible",
      requestId: "fixture-error",
      retryable: false,
    });
  });

  it("writes hello frame fixture with client capabilities", () => {
    const fixture = readJson("hello-frame.json") as FrickFrame;

    expect(fixture[0]).toBe(FrameKind.Hello);
    expect(fixture[1]).toMatchObject({
      replicaId: "fixture-replica",
      deviceId: "fixture-device",
      schemaHash: foundationSchema.hash,
    });
  });
});

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
}
