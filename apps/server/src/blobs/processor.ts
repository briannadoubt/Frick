/**
 * Blob processor types.
 *
 * Apps register blob processors at server boot to hook into the blob upload
 * pipeline. Two phases exist:
 *
 *   - `validate(...)` runs synchronously on the upload request, before any row
 *     is written. Returning `{ ok: false, reason }` rejects the upload with a
 *     `blob.unsupportedContentType` envelope. Use this for fast checks
 *     (MIME-sniffing, size policy, header validation).
 *
 *   - `process(...)` runs asynchronously as a `blob.process` job after the
 *     upload commits. Use this for slow work (thumbnail generation, OCR,
 *     moderation). Returned derivatives are persisted via the
 *     blob-derivative store.
 *
 * Processors declare their match criteria via `matches` — MIME prefix
 * inclusion and an optional max byte length. A processor that omits both
 * matches every blob.
 */
import type { FrickLogger } from "../logger.js";
import type { FrickStore } from "../store.js";

export interface FrickBlobValidateContext {
  tenantId: string;
  blobId: string;
  ownerId: string;
  mimeType: string;
  byteLength: number;
  /** First 4KB of the content for sniffing. May be shorter for tiny blobs. */
  preview: Buffer;
  store: FrickStore;
  logger: FrickLogger;
}

export interface FrickBlobProcessContext {
  tenantId: string;
  blobId: string;
  ownerId: string;
  mimeType: string;
  byteLength: number;
  /**
   * Logical content key for the stored blob. Today this is just the blob id —
   * apps that swap in a filesystem backend can resolve the actual on-disk
   * path through {@link FrickStore} if needed.
   */
  contentPath: string;
  store: FrickStore;
  logger: FrickLogger;
}

export interface FrickBlobValidationResult {
  ok: boolean;
  /** Required when `ok` is false. Surfaced in the error envelope details. */
  reason?: string;
  /** Optional structured metadata extracted from the preview bytes. */
  extractedMetadata?: Record<string, unknown>;
}

export interface FrickBlobDerivative {
  /**
   * Local id within the parent blob (e.g. "thumb-256"). The pair
   * (parentBlobId, derivativeId) is the primary key in storage.
   */
  derivativeId: string;
  mimeType: string;
  bytes: Buffer;
  metadata?: Record<string, unknown>;
}

export interface FrickBlobProcessResult {
  derivatives?: FrickBlobDerivative[];
}

export interface FrickBlobProcessor {
  /** Stable identifier, e.g. "image-thumbnail". Logged with every derivative. */
  id: string;
  matches: {
    /** MIME prefixes the processor matches (e.g. ["image/"]). Undefined matches any. */
    mimePrefixes?: string[];
    /** Skip blobs above this size. Undefined matches any. */
    maxByteLength?: number;
  };
  validate?(ctx: FrickBlobValidateContext): Promise<FrickBlobValidationResult>;
  process?(ctx: FrickBlobProcessContext): Promise<FrickBlobProcessResult>;
}

export interface FrickBlobProcessorRegistry {
  register(processor: FrickBlobProcessor): void;
  list(): FrickBlobProcessor[];
  matching(mimeType: string, byteLength: number): FrickBlobProcessor[];
}

export class DuplicateBlobProcessorError extends Error {
  readonly reason = "duplicateBlobProcessor";
  constructor(readonly processorId: string) {
    super(`A blob processor is already registered with id "${processorId}"`);
    this.name = "DuplicateBlobProcessorError";
  }
}

/**
 * Create a processor registry. Duplicate ids throw at registration time —
 * silently shadowing a processor would make derivative provenance ambiguous,
 * so we'd rather fail loudly at boot.
 */
export function createFrickBlobProcessorRegistry(): FrickBlobProcessorRegistry {
  const processors = new Map<string, FrickBlobProcessor>();
  return {
    register(processor) {
      if (processors.has(processor.id)) {
        throw new DuplicateBlobProcessorError(processor.id);
      }
      processors.set(processor.id, processor);
    },
    list() {
      return Array.from(processors.values());
    },
    matching(mimeType, byteLength) {
      const result: FrickBlobProcessor[] = [];
      for (const processor of processors.values()) {
        if (processorMatches(processor, mimeType, byteLength)) {
          result.push(processor);
        }
      }
      return result;
    },
  };
}

function processorMatches(
  processor: FrickBlobProcessor,
  mimeType: string,
  byteLength: number,
): boolean {
  const { mimePrefixes, maxByteLength } = processor.matches;
  if (mimePrefixes && mimePrefixes.length > 0) {
    const hit = mimePrefixes.some((prefix) => mimeType.startsWith(prefix));
    if (!hit) return false;
  }
  if (typeof maxByteLength === "number" && byteLength > maxByteLength) {
    return false;
  }
  return true;
}
