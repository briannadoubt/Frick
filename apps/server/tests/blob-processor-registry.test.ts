import { describe, expect, it } from "vitest";
import {
  createFrickBlobProcessorRegistry,
  DuplicateBlobProcessorError,
  type FrickBlobProcessor,
} from "../src/blobs/processor.js";

function stubProcessor(overrides: Partial<FrickBlobProcessor>): FrickBlobProcessor {
  return {
    id: "stub",
    matches: {},
    ...overrides,
  };
}

describe("FrickBlobProcessorRegistry", () => {
  it("registers and lists processors", () => {
    const registry = createFrickBlobProcessorRegistry();
    const a = stubProcessor({ id: "a" });
    const b = stubProcessor({ id: "b" });
    registry.register(a);
    registry.register(b);
    expect(registry.list().map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("throws on duplicate id", () => {
    const registry = createFrickBlobProcessorRegistry();
    registry.register(stubProcessor({ id: "dup" }));
    expect(() => registry.register(stubProcessor({ id: "dup" }))).toThrow(
      DuplicateBlobProcessorError,
    );
  });

  it("matches by MIME prefix", () => {
    const registry = createFrickBlobProcessorRegistry();
    const imageProc = stubProcessor({
      id: "image",
      matches: { mimePrefixes: ["image/"] },
    });
    const textProc = stubProcessor({
      id: "text",
      matches: { mimePrefixes: ["text/", "application/json"] },
    });
    const anyProc = stubProcessor({ id: "any", matches: {} });
    registry.register(imageProc);
    registry.register(textProc);
    registry.register(anyProc);

    const imgMatches = registry.matching("image/png", 1).map((p) => p.id);
    expect(imgMatches).toEqual(["image", "any"]);

    const jsonMatches = registry.matching("application/json", 1).map((p) => p.id);
    expect(jsonMatches).toEqual(["text", "any"]);

    const pdfMatches = registry.matching("application/pdf", 1).map((p) => p.id);
    expect(pdfMatches).toEqual(["any"]);
  });

  it("skips processors when byteLength exceeds maxByteLength", () => {
    const registry = createFrickBlobProcessorRegistry();
    registry.register(
      stubProcessor({
        id: "small",
        matches: { mimePrefixes: ["image/"], maxByteLength: 1000 },
      }),
    );
    registry.register(
      stubProcessor({
        id: "any-size",
        matches: { mimePrefixes: ["image/"] },
      }),
    );

    expect(registry.matching("image/png", 500).map((p) => p.id)).toEqual([
      "small",
      "any-size",
    ]);
    expect(registry.matching("image/png", 2000).map((p) => p.id)).toEqual(["any-size"]);
  });
});
