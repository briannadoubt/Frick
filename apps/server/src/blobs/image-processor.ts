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

/**
 * Default ceiling on DECODED pixel count (width × height): 40 megapixels.
 * Independent of encoded byte length — a small (<10 MiB) but maliciously
 * crafted PNG/WebP can declare enormous dimensions (a classic decompression
 * bomb) that blow up memory/CPU when an app's `derivativeGenerator` decodes it.
 * This bound is enforced from the parsed header BEFORE any decode/generate.
 */
export const DEFAULT_MAX_IMAGE_PIXELS = 40 * 1024 * 1024;

export type ImageFormat = "png" | "jpeg" | "gif" | "webp";

/** Decoded image dimensions parsed from the encoded header bytes. */
export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Parse pixel dimensions from the leading header bytes of a recognised image,
 * WITHOUT decoding the pixel data. Returns `null` when the dimensions cannot be
 * determined from the available bytes (truncated header / unsupported variant).
 *
 * This is intentionally header-only and cheap: it exists so the framework can
 * enforce a decoded-size ceiling (decompression-bomb guard) before handing the
 * bytes to an app's image decoder — see {@link imageBlobProcessor}.
 */
export function parseImageDimensions(buffer: Buffer): ImageDimensions | null {
  const format = sniffImageFormat(buffer);
  if (format === "png") {
    // PNG: 8-byte signature, then an IHDR chunk: 4-byte length, "IHDR",
    // 4-byte width, 4-byte height (big-endian). Width/height start at byte 16.
    if (buffer.length < 24) return null;
    if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return finiteDimensions(width, height);
  }
  if (format === "gif") {
    // GIF: 6-byte header, then logical screen width/height as little-endian
    // uint16 at bytes 6 and 8.
    if (buffer.length < 10) return null;
    return finiteDimensions(buffer.readUInt16LE(6), buffer.readUInt16LE(8));
  }
  if (format === "jpeg") {
    return parseJpegDimensions(buffer);
  }
  if (format === "webp") {
    return parseWebpDimensions(buffer);
  }
  return null;
}

function finiteDimensions(width: number, height: number): ImageDimensions | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/** Parse dimensions from a JPEG SOF (start-of-frame) marker. */
function parseJpegDimensions(buffer: Buffer): ImageDimensions | null {
  // Walk the marker segments after the SOI (FF D8) until a SOFn frame header.
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === undefined) return null;
    // Standalone markers (RSTn, SOI, EOI, TEM) carry no length field.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segLength = buffer.readUInt16BE(offset + 2);
    if (segLength < 2) return null;
    // SOF0..SOF15 except the non-frame DHT(C4)/DAC(CC)/RSTn markers.
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // SOF payload: precision(1) height(2) width(2) — height first.
      if (offset + 9 >= buffer.length) return null;
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return finiteDimensions(width, height);
    }
    offset += 2 + segLength;
  }
  return null;
}

/** Parse dimensions from a WebP (VP8 / VP8L / VP8X) container. */
function parseWebpDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 30) return null;
  const fourCc = buffer.toString("ascii", 12, 16);
  if (fourCc === "VP8 ") {
    // Lossy: dimensions are 14-bit LE at byte 26/28 (after the 3-byte start code).
    if (buffer.length < 30) return null;
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    return finiteDimensions(width, height);
  }
  if (fourCc === "VP8L") {
    // Lossless: 1 signature byte then 14-bit width-1, 14-bit height-1 packed LE.
    if (buffer.length < 25) return null;
    const b0 = buffer[21];
    const b1 = buffer[22];
    const b2 = buffer[23];
    const b3 = buffer[24];
    if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) {
      return null;
    }
    const bits = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return finiteDimensions(width, height);
  }
  if (fourCc === "VP8X") {
    // Extended: 24-bit canvas width-1/height-1 LE at byte 24/27.
    if (buffer.length < 30) return null;
    const width = 1 + (buffer.readUIntLE(24, 3) & 0xffffff);
    const height = 1 + (buffer.readUIntLE(27, 3) & 0xffffff);
    return finiteDimensions(width, height);
  }
  return null;
}

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
   * Hard upper bound on DECODED pixel count (width × height). Defaults to
   * {@link DEFAULT_MAX_IMAGE_PIXELS}. This is the decompression-bomb guard: an
   * upload whose parsed header declares more than this many pixels is rejected
   * at `validate` time and never handed to the (potentially app-supplied)
   * `derivativeGenerator`, so a small-but-huge-dimension image can't exhaust
   * memory/CPU during decode. Set to `0`/`Infinity` to disable (not advised).
   */
  maxPixels?: number;
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
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_IMAGE_PIXELS;
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
      // Decompression-bomb guard (FR-130): bound DECODED dimensions, not just
      // encoded bytes. A small file can declare enormous width/height; reject
      // it from the parsed header before any decoder ever sees it. When the
      // dimensions can't be parsed from the available preview bytes we keep the
      // historical behavior (accept) — the byte cap still applies — rather than
      // rejecting on an unparseable-but-valid header.
      const dimensions = parseImageDimensions(ctx.preview);
      if (dimensions && maxPixels > 0 && Number.isFinite(maxPixels)) {
        const pixels = dimensions.width * dimensions.height;
        if (pixels > maxPixels) {
          return {
            ok: false,
            reason: `Image is ${dimensions.width}x${dimensions.height} (${pixels} pixels); the limit is ${maxPixels} pixels.`,
          };
        }
      }
      return {
        ok: true,
        extractedMetadata: {
          format,
          ...(dimensions
            ? { width: dimensions.width, height: dimensions.height }
            : {}),
        },
      };
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
      // Decompression-bomb guard before decode (FR-130): re-check the decoded
      // dimensions against `maxPixels` on the FULL source bytes — `validate`
      // only saw a preview and the byte cap doesn't bound decoded size. An
      // oversized image never reaches the (possibly app-supplied) generator.
      if (maxPixels > 0 && Number.isFinite(maxPixels)) {
        const dimensions = parseImageDimensions(sourceBuffer);
        if (dimensions && dimensions.width * dimensions.height > maxPixels) {
          ctx.logger.warn("frick.blob.image.oversizeDimensions", {
            event: "frick.blob.image.oversizeDimensions",
            blobId: ctx.blobId,
            processorId: id,
            width: dimensions.width,
            height: dimensions.height,
            maxPixels,
          });
          throw new Error(
            `Image ${ctx.blobId} is ${dimensions.width}x${dimensions.height} ` +
              `(${dimensions.width * dimensions.height} pixels); exceeds the ` +
              `${maxPixels}-pixel decode limit.`,
          );
        }
      }
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
