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
  createdAt: string;
}

interface BlobRow {
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

  create(metadata: BlobMetadataInput): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO blob_metadata
          (blob_id, owner_id, content_hash, byte_length, mime_type, storage_key, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        metadata.blobId,
        metadata.ownerId,
        metadata.contentHash,
        metadata.byteLength,
        metadata.mimeType,
        metadata.storageKey ?? null,
        new Date().toISOString(),
      );
  }

  read(blobId: string): BlobMetadata | undefined {
    const row = this.db
      .prepare("SELECT * FROM blob_metadata WHERE blob_id = ?")
      .get(blobId) as BlobRow | undefined;
    if (!row) {
      return undefined;
    }
    return {
      blobId: row.blob_id,
      ownerId: row.owner_id,
      contentHash: row.content_hash,
      byteLength: Number(row.byte_length),
      mimeType: row.mime_type,
      createdAt: row.created_at,
      ...(row.storage_key ? { storageKey: row.storage_key } : {}),
    };
  }

  list(ownerId?: string): BlobMetadata[] {
    const rows = ownerId
      ? (this.db
          .prepare("SELECT * FROM blob_metadata WHERE owner_id = ? ORDER BY created_at DESC, blob_id ASC")
          .all(ownerId) as unknown as BlobRow[])
      : (this.db.prepare("SELECT * FROM blob_metadata ORDER BY created_at DESC, blob_id ASC").all() as unknown as BlobRow[]);
    return rows.map((row) => ({
      blobId: row.blob_id,
      ownerId: row.owner_id,
      contentHash: row.content_hash,
      byteLength: Number(row.byte_length),
      mimeType: row.mime_type,
      createdAt: row.created_at,
      ...(row.storage_key ? { storageKey: row.storage_key } : {}),
    }));
  }

  writeContent(blobId: string, content: Uint8Array): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO blob_content (blob_id, content, updated_at)
          VALUES (?, ?, ?)`,
      )
      .run(blobId, Buffer.from(content), new Date().toISOString());
  }

  readContent(blobId: string): Uint8Array | undefined {
    const row = this.db
      .prepare("SELECT content FROM blob_content WHERE blob_id = ?")
      .get(blobId) as BlobContentRow | undefined;
    return row ? Buffer.from(row.content) : undefined;
  }
}
