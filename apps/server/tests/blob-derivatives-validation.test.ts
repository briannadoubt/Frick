import { describe, expect, it, vi } from "vitest";
import {
  copyDerivativeGenerator,
  imageBlobProcessor,
  mimeSizeValidator,
  moderationProcessor,
  type BlobModerationHook,
  type FrickBlobProcessContext,
  type FrickBlobValidateContext,
} from "../src/index.js";

// FR-55: blob processing pipeline — derivative extraction, MIME/size
// validation, and a moderation extension point. These exercise the new
// factories in isolation against fake store/logger stubs.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
} as unknown as FrickBlobProcessContext["logger"];

/** A minimal store stub whose `blobs.readContent` returns fixed bytes. */
function storeWithContent(bytes: Buffer | undefined): FrickBlobProcessContext["store"] {
  return {
    blobs: {
      readContent: async () => bytes,
    },
  } as unknown as FrickBlobProcessContext["store"];
}

function validateCtx(
  overrides: Partial<FrickBlobValidateContext>,
): FrickBlobValidateContext {
  return {
    tenantId: "_default",
    blobId: "blob-1",
    ownerId: "user-ada",
    mimeType: "application/pdf",
    byteLength: 1024,
    preview: Buffer.alloc(0),
    store: undefined as never,
    logger: noopLogger,
    ...overrides,
  };
}

function processCtx(
  overrides: Partial<FrickBlobProcessContext>,
): FrickBlobProcessContext {
  return {
    tenantId: "_default",
    blobId: "blob-1",
    ownerId: "user-ada",
    mimeType: "image/png",
    byteLength: PNG.byteLength,
    contentPath: "blob-1",
    store: storeWithContent(PNG),
    logger: noopLogger,
    ...overrides,
  };
}

describe("imageBlobProcessor derivative extraction (FR-55)", () => {
  it("stays validate-only when no derivatives are configured", () => {
    expect(imageBlobProcessor().process).toBeUndefined();
  });

  it("generates one derivative per variant via a pluggable generator", async () => {
    const generator = vi.fn(async () => Buffer.from("scaled-bytes"));
    const processor = imageBlobProcessor({
      derivatives: [
        { derivativeId: "thumb-256", maxEdge: 256, mimeType: "image/webp" },
        { derivativeId: "thumb-64", maxEdge: 64 },
      ],
      derivativeGenerator: generator,
    });
    const result = await processor.process!(processCtx({}));
    expect(generator).toHaveBeenCalledTimes(2);
    expect(result.derivatives).toHaveLength(2);
    const [d1, d2] = result.derivatives!;
    expect(d1.derivativeId).toBe("thumb-256");
    expect(d1.mimeType).toBe("image/webp");
    expect(d1.bytes.toString()).toBe("scaled-bytes");
    expect(d1.metadata).toMatchObject({ maxEdge: 256, source: "image-derivative" });
    // Variant without an explicit mimeType inherits the source MIME.
    expect(d2.mimeType).toBe("image/png");
  });

  it("default copy generator returns the source bytes unchanged", async () => {
    const out = await copyDerivativeGenerator({
      source: PNG,
      sourceMimeType: "image/png",
      variant: { derivativeId: "copy" },
    });
    expect(out).toBeInstanceOf(Buffer);
    expect((out as Buffer).equals(PNG)).toBe(true);
  });

  it("skips variants whose generator returns null and emits none on missing content", async () => {
    const skipping = imageBlobProcessor({
      derivatives: [{ derivativeId: "x" }],
      derivativeGenerator: () => null,
    });
    const skipped = await skipping.process!(processCtx({}));
    expect(skipped.derivatives).toEqual([]);

    const missing = imageBlobProcessor({ derivatives: [{ derivativeId: "x" }] });
    const out = await missing.process!(
      processCtx({ store: storeWithContent(undefined) }),
    );
    expect(out.derivatives).toEqual([]);
  });
});

describe("mimeSizeValidator (FR-55)", () => {
  it("accepts an allowed MIME under the size cap", async () => {
    const v = mimeSizeValidator({
      allowedMimeTypes: ["application/pdf", "image/"],
      maxBytes: 2048,
    });
    expect(await v.validate!(validateCtx({ mimeType: "application/pdf" }))).toEqual({
      ok: true,
    });
    // Prefix entry matches by prefix.
    expect(await v.validate!(validateCtx({ mimeType: "image/png" }))).toEqual({
      ok: true,
    });
  });

  it("rejects a disallowed MIME type with a clear reason", async () => {
    const v = mimeSizeValidator({ allowedMimeTypes: ["application/pdf"] });
    const result = await v.validate!(validateCtx({ mimeType: "text/html" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("text/html");
  });

  it("rejects an oversize upload against the configured cap", async () => {
    const v = mimeSizeValidator({ maxBytes: 100 });
    const result = await v.validate!(validateCtx({ byteLength: 101 }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("100");
  });

  it("rejects empty uploads by default and allows opting out", async () => {
    expect((await mimeSizeValidator().validate!(validateCtx({ byteLength: 0 }))).ok).toBe(
      false,
    );
    expect(
      (
        await mimeSizeValidator({ rejectEmpty: false }).validate!(
          validateCtx({ byteLength: 0 }),
        )
      ).ok,
    ).toBe(true);
  });
});

describe("moderationProcessor hook (FR-55)", () => {
  it("fires the app hook with blob content and persists a verdict sidecar", async () => {
    const hook: BlobModerationHook = vi.fn(async () => ({
      decision: "flag" as const,
      reason: "nudity score 0.8",
      details: { score: 0.8 },
    }));
    const processor = moderationProcessor({ hook });
    const result = await processor.process!(processCtx({ mimeType: "image/png" }));

    expect(hook).toHaveBeenCalledTimes(1);
    expect((hook as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      blobId: "blob-1",
      ownerId: "user-ada",
      mimeType: "image/png",
    });
    const arg = (hook as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(Buffer.isBuffer(arg.content)).toBe(true);

    expect(result.derivatives).toHaveLength(1);
    const sidecar = result.derivatives![0];
    expect(sidecar.derivativeId).toBe("moderation");
    expect(sidecar.mimeType).toBe("application/json");
    expect(sidecar.metadata).toMatchObject({ decision: "flag", reason: "nudity score 0.8" });
    expect(JSON.parse(sidecar.bytes.toString("utf8"))).toMatchObject({
      decision: "flag",
      details: { score: 0.8 },
    });
  });

  it("only attaches a process hook, leaving validate to other processors", () => {
    const processor = moderationProcessor({ hook: () => ({ decision: "allow" }) });
    expect(processor.validate).toBeUndefined();
    expect(processor.process).toBeDefined();
  });
});
