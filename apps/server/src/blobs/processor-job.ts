/**
 * blob.process job handler.
 *
 * After a successful blob upload commits, the server enqueues one
 * `blob.process` job per matching processor. This handler:
 *
 *   1. Decodes the job payload `{ blobId, processorId }`.
 *   2. Resolves the processor from the registry and the parent blob from the
 *      store. A missing processor or missing parent is non-retryable — both
 *      can only happen if the registry/store drifts between enqueue and run.
 *   3. Invokes `processor.process(...)`. The handler writes any returned
 *      derivatives via the blob_content store and records a derivative row.
 *
 * Handler-level exceptions are treated as retryable so a transient bug in the
 * processor doesn't burn the retry budget on the first attempt. The router
 * also wraps `decodeIntent` failures separately so payload corruption is
 * non-retryable.
 */
import { createHash } from "node:crypto";
import type { FrickLogger } from "../logger.js";
import type { FrickStore } from "../store.js";
import type { FrickJobHandler, FrickJobResult } from "../jobs/registry.js";
import {
  derivativeStorageKey,
  type BlobDerivativeStore,
} from "../storage/blob-derivative-store.js";
import type {
  FrickBlobDerivative,
  FrickBlobProcessor,
  FrickBlobProcessorRegistry,
} from "./processor.js";

export const BLOB_PROCESS_JOB_TYPE = "blob.process";

export interface BlobProcessJobPayload {
  blobId: string;
  processorId: string;
}

export interface BlobProcessorJobHandlerDeps {
  store: FrickStore;
  blobProcessors: FrickBlobProcessorRegistry;
  logger: FrickLogger;
}

/**
 * Encode a payload for a `blob.process` job. Centralised so the upload route
 * and the handler agree on the wire shape — change in lockstep.
 */
export function encodeBlobProcessPayload(
  payload: BlobProcessJobPayload,
): Record<string, unknown> {
  return { blobId: payload.blobId, processorId: payload.processorId };
}

function decodePayload(raw: unknown): BlobProcessJobPayload | Error {
  if (!raw || typeof raw !== "object") {
    return new Error("blob.process payload must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.blobId !== "string" || record.blobId.length === 0) {
    return new Error("blob.process payload.blobId must be a non-empty string");
  }
  if (typeof record.processorId !== "string" || record.processorId.length === 0) {
    return new Error("blob.process payload.processorId must be a non-empty string");
  }
  return { blobId: record.blobId, processorId: record.processorId };
}

function sha256ContentHash(content: Uint8Array): string {
  return `sha256-${createHash("sha256").update(content).digest("hex")}`;
}

function persistDerivative(
  derivatives: BlobDerivativeStore,
  tenantId: string,
  parentBlobId: string,
  processorId: string,
  derivative: FrickBlobDerivative,
): void {
  const storageKey = derivativeStorageKey(parentBlobId, derivative.derivativeId);
  derivatives.writeBytes(tenantId, storageKey, derivative.bytes);
  derivatives.record({
    parentBlobId,
    derivativeId: derivative.derivativeId,
    tenantId,
    processorId,
    mimeType: derivative.mimeType,
    byteLength: derivative.bytes.byteLength,
    contentHash: sha256ContentHash(derivative.bytes),
    storageKey,
    ...(derivative.metadata ? { metadata: derivative.metadata } : {}),
  });
}

export function createBlobProcessorJobHandler(
  deps: BlobProcessorJobHandlerDeps,
): FrickJobHandler {
  const { store, blobProcessors, logger } = deps;

  const handler: FrickJobHandler = async (ctx) => {
    const decoded = decodePayload(ctx.payload);
    if (decoded instanceof Error) {
      const result: FrickJobResult = {
        status: "failed",
        errorCode: "blob.invalidPayload",
        errorMessage: decoded.message,
        retryable: false,
      };
      return result;
    }
    const { blobId, processorId } = decoded;
    const processor: FrickBlobProcessor | undefined = blobProcessors
      .list()
      .find((p) => p.id === processorId);
    if (!processor) {
      return {
        status: "failed",
        errorCode: "blob.unknownProcessor",
        errorMessage: `No blob processor registered with id "${processorId}"`,
        retryable: false,
      };
    }
    if (!processor.process) {
      // Validate-only processors should never have produced an enqueue, but
      // a registry change between enqueue and run could leave a stale job.
      return { status: "completed", result: { derivatives: 0 } };
    }
    const metadata = store.blobs.read(ctx.tenantId, blobId);
    if (!metadata) {
      return {
        status: "failed",
        errorCode: "blob.notFound",
        errorMessage: `Blob ${blobId} not found in tenant ${ctx.tenantId}`,
        retryable: false,
      };
    }
    try {
      const outcome = await processor.process({
        tenantId: ctx.tenantId,
        blobId,
        ownerId: metadata.ownerId,
        mimeType: metadata.mimeType,
        byteLength: metadata.byteLength,
        // Today the framework stores blob bytes in SQLite keyed by blob_id;
        // the storage_key column is the logical content path. Apps that
        // swap in a filesystem backend can resolve this to an absolute path.
        contentPath: metadata.storageKey ?? metadata.blobId,
        store,
        logger: ctx.logger,
      });
      const derivatives = outcome.derivatives ?? [];
      for (const derivative of derivatives) {
        persistDerivative(
          store.blobDerivatives,
          ctx.tenantId,
          blobId,
          processorId,
          derivative,
        );
      }
      logger.info("frick.blob.processed", {
        event: "frick.blob.processed",
        blobId,
        processorId,
        derivatives: derivatives.length,
      });
      return {
        status: "completed",
        result: { derivatives: derivatives.length },
      };
    } catch (error) {
      // Processor exceptions are retryable by default — most failures are
      // transient (network, decode glitch). Non-retryable failures should be
      // reported by the processor itself via `process()` future-evolutions.
      return {
        status: "failed",
        errorCode: "blob.processorError",
        errorMessage: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }
  };

  return handler;
}
