import type { DatabaseSync } from "node:sqlite";
import {
  SqliteBlobBytesDriver,
  type BlobBytesDriver,
} from "./blob-bytes-driver.js";

export interface BlobMetadataInput {
  blobId: string;
  ownerId: string;
  contentHash: string;
  byteLength: number;
  mimeType: string;
  storageKey?: string;
}

export interface BlobMetadata extends BlobMetadataInput {
  tenantId: string;
  createdAt: string;
}

interface BlobRow {
  tenant_id: string;
  blob_id: string;
  owner_id: string;
  content_hash: string;
  byte_length: number;
  mime_type: string;
  storage_key: string | null;
  created_at: string;
}

export class BlobStore {
  readonly #bytes: BlobBytesDriver;

  /**
   * Blob *metadata* always lives in SQLite (`this.db`). Blob *bytes* are served
   * by a pluggable {@link BlobBytesDriver} (FR-53). When no driver is supplied,
   * the store defaults to the SQLite bytes driver, preserving the historical
   * behavior of storing bytes in the `blob_content` table.
   */
  constructor(
    private readonly db: DatabaseSync,
    bytes?: BlobBytesDriver,
  ) {
    this.#bytes = bytes ?? new SqliteBlobBytesDriver(db);
  }

  create(tenantId: string, metadata: BlobMetadataInput): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO blob_metadata
          (tenant_id, blob_id, owner_id, content_hash, byte_length, mime_type, storage_key, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tenantId,
        metadata.blobId,
        metadata.ownerId,
        metadata.contentHash,
        metadata.byteLength,
        metadata.mimeType,
        metadata.storageKey ?? null,
        new Date().toISOString(),
      );
  }

  read(tenantId: string, blobId: string): BlobMetadata | undefined {
    const row = this.db
      .prepare("SELECT * FROM blob_metadata WHERE tenant_id = ? AND blob_id = ?")
      .get(tenantId, blobId) as BlobRow | undefined;
    if (!row) {
      return undefined;
    }
    return mapBlobRow(row);
  }

  list(tenantId: string, ownerId?: string): BlobMetadata[] {
    const rows = ownerId
      ? (this.db
          .prepare(
            "SELECT * FROM blob_metadata WHERE tenant_id = ? AND owner_id = ? ORDER BY created_at DESC, blob_id ASC",
          )
          .all(tenantId, ownerId) as unknown as BlobRow[])
      : (this.db
          .prepare(
            "SELECT * FROM blob_metadata WHERE tenant_id = ? ORDER BY created_at DESC, blob_id ASC",
          )
          .all(tenantId) as unknown as BlobRow[]);
    return rows.map(mapBlobRow);
  }

  /**
   * Sum the `byte_length` of every blob owned by `(tenantId, ownerId)`. This is
   * the per-principal usage figure the upload route checks against the
   * configured quota (FR-56). The query is tenant- and owner-scoped, so one
   * principal's usage never reflects another principal's or another tenant's
   * blobs. Returns `0` when the owner has no blobs.
   */
  totalBytesForOwner(tenantId: string, ownerId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(byte_length), 0) AS total FROM blob_metadata WHERE tenant_id = ? AND owner_id = ?",
      )
      .get(tenantId, ownerId) as { total: number | bigint } | undefined;
    return row ? Number(row.total) : 0;
  }

  writeContent(tenantId: string, blobId: string, content: Uint8Array): void {
    this.#bytes.write(tenantId, blobId, content);
  }

  readContent(tenantId: string, blobId: string): Uint8Array | undefined {
    return this.#bytes.read(tenantId, blobId);
  }

  deleteContent(tenantId: string, blobId: string): void {
    this.#bytes.delete(tenantId, blobId);
  }

  hasContent(tenantId: string, blobId: string): boolean {
    return this.#bytes.exists(tenantId, blobId);
  }
}

function mapBlobRow(row: BlobRow): BlobMetadata {
  return {
    tenantId: row.tenant_id,
    blobId: row.blob_id,
    ownerId: row.owner_id,
    contentHash: row.content_hash,
    byteLength: Number(row.byte_length),
    mimeType: row.mime_type,
    createdAt: row.created_at,
    ...(row.storage_key ? { storageKey: row.storage_key } : {}),
  };
}
