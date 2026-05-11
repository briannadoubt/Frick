import type { DatabaseSync } from "node:sqlite";

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

interface BlobContentRow {
  content: Uint8Array;
}

export class BlobStore {
  constructor(private readonly db: DatabaseSync) {}

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

  writeContent(tenantId: string, blobId: string, content: Uint8Array): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO blob_content (blob_id, content, updated_at, tenant_id)
          VALUES (?, ?, ?, ?)`,
      )
      .run(blobId, Buffer.from(content), new Date().toISOString(), tenantId);
  }

  readContent(tenantId: string, blobId: string): Uint8Array | undefined {
    const row = this.db
      .prepare("SELECT content FROM blob_content WHERE tenant_id = ? AND blob_id = ?")
      .get(tenantId, blobId) as BlobContentRow | undefined;
    return row ? Buffer.from(row.content) : undefined;
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
