import {
  SqliteBlobBytesDriver,
  type BlobBytesDriver,
} from "./blob-bytes-driver.js";
import type { SqlDriver } from "./sql-driver.js";
import type { SqliteSqlDriver } from "./sql-driver.js";

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
   * Blob *metadata* always lives in the SQL driver (`this.sql`). Blob *bytes*
   * are served by a pluggable {@link BlobBytesDriver} (FR-53). When no driver
   * is supplied, the store defaults to the SQLite bytes driver, preserving the
   * historical behavior of storing bytes in the `blob_content` table.
   */
  constructor(
    private readonly sql: SqlDriver,
    bytes?: BlobBytesDriver,
  ) {
    // Fall back to the SQLite bytes driver using the raw DatabaseSync handle
    // exposed by SqliteSqlDriver. This keeps the bytes driver synchronous
    // (BlobBytesDriver interface is sync) while the metadata path is async.
    this.#bytes =
      bytes ??
      new SqliteBlobBytesDriver(
        (sql as SqliteSqlDriver).rawDb,
      );
  }

  async create(tenantId: string, metadata: BlobMetadataInput): Promise<void> {
    await this.sql.run(
      `INSERT INTO blob_metadata
          (tenant_id, blob_id, owner_id, content_hash, byte_length, mime_type, storage_key, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(blob_id) DO UPDATE SET
            tenant_id = excluded.tenant_id,
            owner_id = excluded.owner_id,
            content_hash = excluded.content_hash,
            byte_length = excluded.byte_length,
            mime_type = excluded.mime_type,
            storage_key = excluded.storage_key,
            created_at = excluded.created_at`,
      [
        tenantId,
        metadata.blobId,
        metadata.ownerId,
        metadata.contentHash,
        metadata.byteLength,
        metadata.mimeType,
        metadata.storageKey ?? null,
        new Date().toISOString(),
      ],
    );
  }

  async read(tenantId: string, blobId: string): Promise<BlobMetadata | undefined> {
    const row = await this.sql.get<BlobRow>(
      "SELECT * FROM blob_metadata WHERE tenant_id = ? AND blob_id = ?",
      [tenantId, blobId],
    );
    if (!row) {
      return undefined;
    }
    return mapBlobRow(row);
  }

  async list(tenantId: string, ownerId?: string): Promise<BlobMetadata[]> {
    const rows = ownerId
      ? await this.sql.all<BlobRow>(
          "SELECT * FROM blob_metadata WHERE tenant_id = ? AND owner_id = ? ORDER BY created_at DESC, blob_id ASC",
          [tenantId, ownerId],
        )
      : await this.sql.all<BlobRow>(
          "SELECT * FROM blob_metadata WHERE tenant_id = ? ORDER BY created_at DESC, blob_id ASC",
          [tenantId],
        );
    return rows.map(mapBlobRow);
  }

  /**
   * Sum the `byte_length` of every blob owned by `(tenantId, ownerId)`. This is
   * the per-principal usage figure the upload route checks against the
   * configured quota (FR-56). The query is tenant- and owner-scoped, so one
   * principal's usage never reflects another principal's or another tenant's
   * blobs. Returns `0` when the owner has no blobs.
   */
  async totalBytesForOwner(tenantId: string, ownerId: string): Promise<number> {
    const row = await this.sql.get<{ total: number | bigint }>(
      "SELECT COALESCE(SUM(byte_length), 0) AS total FROM blob_metadata WHERE tenant_id = ? AND owner_id = ?",
      [tenantId, ownerId],
    );
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
