/**
 * Stock image blob processor + magic-byte sniffer (FR-130).
 *
 * Frick owns the blob upload pipeline but leaves the `validate` hook to the
 * app, so every app that accepts image uploads rewrites the same magic-byte
 * sniffing + size/MIME gate. This ships that as framework utilities:
 *
 *   - {@link sniffImageFormat} — recognise PNG / JPEG / GIF / WebP from the
 *     leading bytes of an upload, as defense in depth against a lying
 *     `Content-Type`.
 *   - {@link imageBlobProcessor} — a configurable {@link FrickBlobProcessor}
 *     factory whose `validate` rejects empty uploads, oversize uploads,
 *     non-`image/*` MIME types, and anything whose bytes aren't a recognised
 *     image, before the blob ever reaches storage.
 *
 * Only the size cap and rejection copy are app config; the sniffing is generic.
 */
import type {
  FrickBlobDerivative,
  FrickBlobProcessContext,
  FrickBlobProcessor,
  FrickBlobProcessResult,
  FrickBlobValidationResult,
} from "./processor.js";

/** Default ceiling for an uploaded image: 10 MiB. */
export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type ImageFormat = "png" | "jpeg" | "gif" | "webp";

/**
 * Sniff common image magic bytes from the leading bytes of an upload.
 * Returns the detected format, or `null` when the bytes match no known image.
 */
export function sniffImageFormat(preview: Buffer): ImageFormat | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    preview.length >= 8 &&
    preview[0] === 0x89 &&
    preview[1] === 0x50 &&
    preview[2] === 0x4e &&
    preview[3] === 0x47
  ) {
    return "png";
  }
  // JPEG: FF D8 FF
  if (preview.length >= 3 && preview[0] === 0xff && preview[1] === 0xd8 && preview[2] === 0xff) {
    return "jpeg";
  }
  // GIF: "GIF87a" / "GIF89a"
  if (preview.length >= 6 && preview[0] === 0x47 && preview[1] === 0x49 && preview[2] === 0x46) {
    return "gif";
  }
  // WebP: "RIFF"...."WEBP"
  if (
    preview.length >= 12 &&
    preview.toString("ascii", 0, 4) === "RIFF" &&
    preview.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

export interface ImageBlobProcessorOptions {
  /** Processor id. Defaults to `"frick-image"`. */
  id?: string;
  /** Hard upper bound on upload size. Defaults to {@link DEFAULT_MAX_IMAGE_BYTES}. */
  maxBytes?: number;
  /**
   * Rejection message surfaced when an upload isn't a recognised image (wrong
   * MIME or unknown magic bytes). Defaults to a generic message naming the
   * accepted formats.
   */
  message?: string;
  /**
   * Match criteria. Defaults to `{}` — match every upload, so non-images are
   * actively rejected rather than silently skipped. Narrow it (e.g.
   * `{ mimePrefixes: ["image/"] }`) to let other processors own non-images.
   */
  matches?: FrickBlobProcessor["matches"];
  /**
   * Derivative variants to generate asynchronously after upload (FR-55).
   * When supplied (non-empty), the processor gains a `process(...)` hook that
   * reads the stored blob bytes and emits one derivative per variant via the
   * {@link ImageDerivativeGenerator}. Omit (the default) for a validate-only
   * processor that ships no derivatives.
   */
  derivatives?: ImageDerivativeVariant[];
  /**
   * Pluggable byte transformer used to produce each derivative's content.
   * Defaults to {@link copyDerivativeGenerator}, which simply re-tags the
   * original bytes — no native image library required. Apps that want real
   * resizing supply their own (e.g. a `sharp` wrapper) without changing the
   * pipeline. Tests can pass a deterministic fake.
   */
  derivativeGenerator?: ImageDerivativeGenerator;
}

/** A single derivative variant to emit for a processable image. */
export interface ImageDerivativeVariant {
  /** Local id within the parent blob, e.g. "thumb-256". */
  derivativeId: string;
  /** Longest-edge target in pixels. Advisory — passed to the generator. */
  maxEdge?: number;
  /** MIME type of the produced derivative. Defaults to the source MIME. */
  mimeType?: string;
}

/** Input handed to an {@link ImageDerivativeGenerator}. */
export interface ImageDerivativeGeneratorInput {
  source: Buffer;
  sourceMimeType: string;
  variant: ImageDerivativeVariant;
}

/**
 * Produces derivative bytes from source image bytes. Pure function of its
 * input so it stays trivially testable and backend-agnostic. Returning
 * `null`/`undefined` skips the variant (e.g. unsupported source format).
 */
export type ImageDerivativeGenerator = (
  input: ImageDerivativeGeneratorInput,
) => Promise<Buffer | null | undefined> | Buffer | null | undefined;

/**
 * Default, dependency-free derivative generator: returns the source bytes
 * unchanged. This keeps the framework usable out of the box (the derivative is
 * a content-addressed copy) and lets apps swap in real resizing later without
 * touching the pipeline.
 */
export const copyDerivativeGenerator: ImageDerivativeGenerator = ({ source }) =>
  Buffer.from(source);

const DEFAULT_REJECTION_MESSAGE =
  "Upload is not a recognised PNG, JPEG, GIF, or WebP image.";

/**
 * Build a {@link FrickBlobProcessor} that validates image uploads: rejects
 * empty and oversize uploads, non-`image/*` MIME types, and bytes that don't
 * sniff as a known image. On success it attaches `{ format }` to the blob's
 * extracted metadata.
 */
export function imageBlobProcessor(options: ImageBlobProcessorOptions = {}): FrickBlobProcessor {
  const id = options.id ?? "frick-image";
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const message = options.message ?? DEFAULT_REJECTION_MESSAGE;
  const matches = options.matches ?? {};
  const variants = options.derivatives ?? [];
  const generate = options.derivativeGenerator ?? copyDerivativeGenerator;

  const processor: FrickBlobProcessor = {
    id,
    matches,
    async validate(ctx): Promise<FrickBlobValidationResult> {
      if (ctx.byteLength === 0) {
        return { ok: false, reason: "Empty upload." };
      }
      if (ctx.byteLength > maxBytes) {
        return {
          ok: false,
          reason: `Image is ${ctx.byteLength} bytes; the limit is ${maxBytes}.`,
        };
      }
      if (!ctx.mimeType.startsWith("image/")) {
        return { ok: false, reason: message };
      }
      const format = sniffImageFormat(ctx.preview);
      if (!format) {
        return { ok: false, reason: message };
      }
      return { ok: true, extractedMetadata: { format } };
    },
  };

  // Only attach a `process` hook when there are variants to emit — a
  // validate-only processor must not enqueue empty jobs.
  if (variants.length > 0) {
    processor.process = async (
      ctx: FrickBlobProcessContext,
    ): Promise<FrickBlobProcessResult> => {
      const source = await ctx.store.blobs.readContent(ctx.tenantId, ctx.blobId);
      if (!source) {
        ctx.logger.warn("frick.blob.image.missingContent", {
          event: "frick.blob.image.missingContent",
          blobId: ctx.blobId,
          processorId: id,
        });
        return { derivatives: [] };
      }
      const sourceBuffer = Buffer.from(source);
      const derivatives: FrickBlobDerivative[] = [];
      for (const variant of variants) {
        const bytes = await generate({
          source: sourceBuffer,
          sourceMimeType: ctx.mimeType,
          variant,
        });
        if (!bytes) continue;
        derivatives.push({
          derivativeId: variant.derivativeId,
          mimeType: variant.mimeType ?? ctx.mimeType,
          bytes,
          metadata: {
            ...(variant.maxEdge !== undefined ? { maxEdge: variant.maxEdge } : {}),
            source: "image-derivative",
          },
        });
      }
      return { derivatives };
    };
  }

  return processor;
}
