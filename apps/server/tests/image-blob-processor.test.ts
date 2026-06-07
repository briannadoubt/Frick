import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  imageBlobProcessor,
  sniffImageFormat,
  type FrickBlobValidateContext,
} from "../src/index.js";

// FR-130: a stock image blob processor + magic-byte sniffer so apps stop
// re-implementing image upload validation. The sniffer recognises PNG/JPEG/
// GIF/WebP; the processor rejects empty, oversize, non-image, and
// unrecognised uploads before they reach storage.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.from("GIF89a", "ascii");
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "ascii"),
]);

function ctx(overrides: Partial<FrickBlobValidateContext>): FrickBlobValidateContext {
  return {
    tenantId: "_default",
    blobId: "blob-1",
    ownerId: "user-ada",
    mimeType: "image/png",
    byteLength: 1024,
    preview: PNG,
    store: undefined as never,
    logger: undefined as never,
    ...overrides,
  };
}

describe("sniffImageFormat", () => {
  it("recognises the four supported formats", () => {
    expect(sniffImageFormat(PNG)).toBe("png");
    expect(sniffImageFormat(JPEG)).toBe("jpeg");
    expect(sniffImageFormat(GIF)).toBe("gif");
    expect(sniffImageFormat(WEBP)).toBe("webp");
  });

  it("returns null for non-image bytes and truncated previews", () => {
    expect(sniffImageFormat(Buffer.from("not an image", "ascii"))).toBeNull();
    expect(sniffImageFormat(Buffer.from([0x89, 0x50]))).toBeNull(); // too short for PNG
    expect(sniffImageFormat(Buffer.alloc(0))).toBeNull();
    // A RIFF container that isn't WebP must not be mistaken for one.
    const wav = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from("WAVE", "ascii"),
    ]);
    expect(sniffImageFormat(wav)).toBeNull();
  });
});

describe("imageBlobProcessor", () => {
  it("accepts a valid image and attaches the sniffed format", async () => {
    const processor = imageBlobProcessor();
    const result = await processor.validate!(ctx({ mimeType: "image/jpeg", preview: JPEG }));
    expect(result).toEqual({ ok: true, extractedMetadata: { format: "jpeg" } });
  });

  it("defaults to matching every upload so non-images are rejected", () => {
    expect(imageBlobProcessor().matches).toEqual({});
    expect(imageBlobProcessor().id).toBe("frick-image");
  });

  it("rejects an empty upload", async () => {
    const result = await imageBlobProcessor().validate!(ctx({ byteLength: 0 }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/empty/i);
  });

  it("rejects an oversize upload against the configured cap", async () => {
    const processor = imageBlobProcessor({ maxBytes: 100 });
    const result = await processor.validate!(ctx({ byteLength: 101 }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("100");
  });

  it("rejects a non-image MIME type with the configured message", async () => {
    const processor = imageBlobProcessor({ message: "images only please" });
    const result = await processor.validate!(ctx({ mimeType: "application/pdf" }));
    expect(result).toEqual({ ok: false, reason: "images only please" });
  });

  it("rejects an image/* MIME whose bytes don't sniff as an image (lying Content-Type)", async () => {
    const result = await imageBlobProcessor().validate!(
      ctx({ mimeType: "image/png", preview: Buffer.from("totally not a png", "ascii") }),
    );
    expect(result.ok).toBe(false);
  });

  it("honors a custom id and exposes the default cap constant", () => {
    expect(imageBlobProcessor({ id: "my-image" }).id).toBe("my-image");
    expect(DEFAULT_MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024);
  });
});
