import type { Principal } from "../authz.js";
import type { FrickStore } from "../store.js";
import type { BlobMetadata } from "../storage/blob-store.js";

const DEFAULT_BLOB_LIMIT = 50;
const MAX_BLOB_LIMIT = 200;

export interface DashboardBlobRow {
  readonly tenantId: string;
  readonly blobId: string;
  readonly ownerId: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly mimeType: string;
  readonly createdAt: string;
}

export interface DashboardBlobs {
  readonly schemaHash: string;
  readonly tenantId: string;
  readonly ownerId?: string;
  readonly scope: "tenant" | "admin";
  readonly limit: number;
  readonly count: number;
  readonly total: number;
  readonly truncated: boolean;
  readonly blobs: readonly DashboardBlobRow[];
}

export interface BuildDashboardBlobsInput {
  readonly store: FrickStore;
  readonly principal: Principal;
  readonly tenantId?: string;
  readonly ownerId?: string;
  readonly limit?: number;
}

export function buildDashboardBlobs(input: BuildDashboardBlobsInput): DashboardBlobs {
  const scope = input.principal.scope === "admin" ? "admin" : "tenant";
  const tenantId = scope === "admin"
    ? input.tenantId || input.principal.tenantId
    : input.principal.tenantId;
  const ownerId = scope === "admin" ? input.ownerId : input.principal.userId;
  const limit = normalizeDashboardBlobLimit(input.limit);
  const visibleBlobs = input.store.blobs.list(tenantId, ownerId);
  const blobs = visibleBlobs.slice(0, limit).map(toDashboardBlobRow);

  return {
    schemaHash: input.store.schema.hash,
    tenantId,
    ...(ownerId ? { ownerId } : {}),
    scope,
    limit,
    count: blobs.length,
    total: visibleBlobs.length,
    truncated: visibleBlobs.length > blobs.length,
    blobs,
  };
}

export function normalizeDashboardBlobLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_BLOB_LIMIT;
  }
  return Math.min(MAX_BLOB_LIMIT, Math.floor(value));
}

function toDashboardBlobRow(blob: BlobMetadata): DashboardBlobRow {
  return {
    tenantId: blob.tenantId,
    blobId: blob.blobId,
    ownerId: blob.ownerId,
    contentHash: blob.contentHash,
    byteLength: blob.byteLength,
    mimeType: blob.mimeType,
    createdAt: blob.createdAt,
  };
}
