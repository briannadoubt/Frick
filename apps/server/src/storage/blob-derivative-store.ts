import type { DatabaseSync } from "node:sqlite";

/**
 * Storage for blob derivatives — child blobs produced by the blob processor
 * pipeline (thumbnails, transcoded variants, extracted-metadata sidecars).
 *
 * Each derivative is keyed by (tenantId, parentBlobId, derivativeId) and
 * carries the same content-addressing bookkeeping as the parent
 * (`content_hash`, `byte_length`, `mime_type`). Bytes themselves are stored
 * in the existing `blob_content` table under the derivative's
 * `storage_key`, reusing the framework's content-blob path resolution.
 */
export interface DerivativeRow {
  parentBlobId: string;
  derivativeId: string;
  tenantId: string;
  processorId: string;
  mimeType: string;
  byteLength: number;
  contentHash: string;
  storageKey: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

interface RawDerivativeRow {
  parent_blob_id: string;
  derivative_id: string;
  tenant_id: string;
  processor_id: string;
  mime_type: string;
  byte_length: number;
  content_hash: string;
  storage_key: string;
  metadata: string | null;
  created_at: string;
}

export interface RecordDerivativeInput {
  parentBlobId: string;
  derivativeId: string;
  tenantId: string;
  processorId: string;
  mimeType: string;
  byteLength: number;
  contentHash: string;
  storageKey: string;
  metadata?: Record<string, unknown>;
}

/**
 * Compute the canonical storage key for a derivative. Used by callers that
 * want a stable path-style key for both the `blob_derivatives` row and the
 * `blob_content` row that holds the bytes.
 */
export function derivativeStorageKey(
  parentBlobId: string,
  derivativeId: string,
): string {
  return `derivative/${parentBlobId}/${derivativeId}`;
}

export class BlobDerivativeStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Insert (or replace) a derivative row. Replacement happens on the
   * (tenant, parent, derivative) primary key — re-running a processor for the
   * same parent simply overwrites the previous derivative.
   */
  record(input: RecordDerivativeInput): DerivativeRow {
    const now = new Date().toISOString();
    const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO blob_derivatives
          (parent_blob_id, derivative_id, tenant_id, processor_id, mime_type,
           byte_length, content_hash, storage_key, metadata, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.parentBlobId,
        input.derivativeId,
        input.tenantId,
        input.processorId,
        input.mimeType,
        input.byteLength,
        input.contentHash,
        input.storageKey,
        metadataJson,
        now,
      );
    return {
      parentBlobId: input.parentBlobId,
      derivativeId: input.derivativeId,
      tenantId: input.tenantId,
      processorId: input.processorId,
      mimeType: input.mimeType,
      byteLength: input.byteLength,
      contentHash: input.contentHash,
      storageKey: input.storageKey,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      createdAt: now,
    };
  }

  listForParent(parentBlobId: string, tenantId: string): DerivativeRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM blob_derivatives
          WHERE tenant_id = ? AND parent_blob_id = ?
          ORDER BY derivative_id ASC`,
      )
      .all(tenantId, parentBlobId) as unknown as RawDerivativeRow[];
    return rows.map(mapRow);
  }

  read(
    parentBlobId: string,
    derivativeId: string,
    tenantId: string,
  ): { row: DerivativeRow; bytes: Buffer } | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM blob_derivatives
          WHERE tenant_id = ? AND parent_blob_id = ? AND derivative_id = ?
          LIMIT 1`,
      )
      .get(tenantId, parentBlobId, derivativeId) as RawDerivativeRow | undefined;
    if (!row) return undefined;
    const mapped = mapRow(row);
    const contentRow = this.db
      .prepare(
        `SELECT content FROM blob_content WHERE tenant_id = ? AND blob_id = ?`,
      )
      .get(tenantId, mapped.storageKey) as { content: Uint8Array } | undefined;
    if (!contentRow) return undefined;
    return { row: mapped, bytes: Buffer.from(contentRow.content) };
  }

  /**
   * Persist derivative bytes via the existing blob_content table. The
   * `storage_key` doubles as the blob_id within `blob_content` — derivative
   * keys live under the `derivative/...` namespace and never collide with
   * top-level blob ids.
   */
  writeBytes(tenantId: string, storageKey: string, bytes: Buffer): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO blob_content (blob_id, content, updated_at, tenant_id)
          VALUES (?, ?, ?, ?)`,
      )
      .run(storageKey, bytes, new Date().toISOString(), tenantId);
  }
}

function mapRow(row: RawDerivativeRow): DerivativeRow {
  const out: DerivativeRow = {
    parentBlobId: row.parent_blob_id,
    derivativeId: row.derivative_id,
    tenantId: row.tenant_id,
    processorId: row.processor_id,
    mimeType: row.mime_type,
    byteLength: Number(row.byte_length),
    contentHash: row.content_hash,
    storageKey: row.storage_key,
    createdAt: row.created_at,
  };
  if (row.metadata) {
    try {
      out.metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      // Corrupt metadata blob: surface as missing rather than failing the
      // whole list — operators can see the raw column via SQLite.
    }
  }
  return out;
}
