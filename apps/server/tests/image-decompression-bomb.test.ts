import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_IMAGE_PIXELS,
  imageBlobProcessor,
  parseImageDimensions,
} from "../src/blobs/image-processor.js";
import { createNoopLogger } from "../src/logger.js";
import { FrickStore } from "../src/store.js";
import { productTestSchema } from "@fricken/protocol";
import type {
  FrickBlobProcessContext,
  FrickBlobValidateContext,
} from "../src/blobs/processor.js";

// Regression for blob-gc-5: the image processor must impose a DECODED-dimension
// bound (decompression-bomb guard), not only an encoded-byte cap. A small file
// that declares enormous width/height must be rejected at validate AND never
// reach the (possibly app-supplied) derivative generator at process time.

/** Build a minimal PNG header (8-byte sig + IHDR) declaring width × height. */
function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  // PNG signature.
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8); // IHDR length
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** Build a minimal GIF89a header declaring logical screen width × height. */
function gifHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13);
  buf.write("GIF89a", 0, "ascii");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function validateCtx(preview: Buffer): FrickBlobValidateContext {
  return {
    tenantId: "_default",
    blobId: "blob-1",
    ownerId: "user-1",
    mimeType: "image/png",
    byteLength: preview.length,
    preview,
    // store/logger unused by the image validator.
    store: undefined as never,
    logger: createNoopLogger(),
  };
}

describe("parseImageDimensions", () => {
  it("parses PNG IHDR dimensions", () => {
    expect(parseImageDimensions(pngHeader(640, 480))).toEqual({ width: 640, height: 480 });
  });
  it("parses GIF logical-screen dimensions", () => {
    expect(parseImageDimensions(gifHeader(320, 200))).toEqual({ width: 320, height: 200 });
  });
  it("returns null for a truncated / unrecognised header", () => {
    expect(parseImageDimensions(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(parseImageDimensions(Buffer.from("not an image"))).toBeNull();
  });
});

describe("imageBlobProcessor — decompression-bomb guard (validate)", () => {
  it("rejects a small file that declares > maxPixels", async () => {
    const processor = imageBlobProcessor();
    // 100000 × 100000 = 1e10 pixels, far above the 40 MP default, in 24 bytes.
    const bomb = pngHeader(100_000, 100_000);
    const result = await processor.validate!(validateCtx(bomb));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("pixels");
  });

  it("accepts an image within the pixel bound and exposes dimensions", async () => {
    const processor = imageBlobProcessor();
    const ok = pngHeader(800, 600);
    const result = await processor.validate!(validateCtx(ok));
    expect(result.ok).toBe(true);
    expect(result.extractedMetadata).toMatchObject({
      format: "png",
      width: 800,
      height: 600,
    });
  });

  it("honours a custom maxPixels", async () => {
    const processor = imageBlobProcessor({ maxPixels: 100 });
    const result = await processor.validate!(validateCtx(pngHeader(50, 50)));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("2500 pixels");
  });

  it("the default ceiling is DEFAULT_MAX_IMAGE_PIXELS", async () => {
    const processor = imageBlobProcessor();
    const edge = Math.floor(Math.sqrt(DEFAULT_MAX_IMAGE_PIXELS));
    // Just under the limit passes.
    expect((await processor.validate!(validateCtx(pngHeader(edge, edge)))).ok).toBe(true);
    // Comfortably over the limit fails.
    expect((await processor.validate!(validateCtx(pngHeader(edge * 2, edge * 2)))).ok).toBe(false);
  });
});

describe("imageBlobProcessor — decompression-bomb guard (process)", () => {
  it("never invokes the generator for an oversized image and throws", async () => {
    const store = new FrickStore({ path: ":memory:", seed: true, schema: productTestSchema });
    try {
      const bomb = pngHeader(100_000, 100_000);
      await store.blobs.create("_default", {
        blobId: "bomb-1",
        ownerId: "user-1",
        contentHash: "sha256-bomb",
        byteLength: bomb.length,
        mimeType: "image/png",
      });
      await store.blobs.writeContent("_default", "bomb-1", bomb);

      let generatorCalls = 0;
      const processor = imageBlobProcessor({
        derivatives: [{ derivativeId: "thumb", maxEdge: 256 }],
        derivativeGenerator: () => {
          generatorCalls += 1;
          return Buffer.from([0]);
        },
      });

      const ctx: FrickBlobProcessContext = {
        tenantId: "_default",
        blobId: "bomb-1",
        ownerId: "user-1",
        mimeType: "image/png",
        byteLength: bomb.length,
        contentPath: "bomb-1",
        store,
        logger: createNoopLogger(),
      };

      await expect(processor.process!(ctx)).rejects.toThrow(/pixel/);
      expect(generatorCalls).toBe(0);
    } finally {
      store.close();
    }
  });

  it("still generates derivatives for an in-bound image", async () => {
    const store = new FrickStore({ path: ":memory:", seed: true, schema: productTestSchema });
    try {
      const ok = pngHeader(64, 64);
      await store.blobs.create("_default", {
        blobId: "ok-1",
        ownerId: "user-1",
        contentHash: "sha256-ok",
        byteLength: ok.length,
        mimeType: "image/png",
      });
      await store.blobs.writeContent("_default", "ok-1", ok);

      let generatorCalls = 0;
      const processor = imageBlobProcessor({
        derivatives: [{ derivativeId: "thumb", maxEdge: 32 }],
        derivativeGenerator: () => {
          generatorCalls += 1;
          return Buffer.from([1, 2, 3]);
        },
      });

      const ctx: FrickBlobProcessContext = {
        tenantId: "_default",
        blobId: "ok-1",
        ownerId: "user-1",
        mimeType: "image/png",
        byteLength: ok.length,
        contentPath: "ok-1",
        store,
        logger: createNoopLogger(),
      };

      const result = await processor.process!(ctx);
      expect(generatorCalls).toBe(1);
      expect(result.derivatives).toHaveLength(1);
      expect(result.derivatives![0]!.derivativeId).toBe("thumb");
    } finally {
      store.close();
    }
  });
});
