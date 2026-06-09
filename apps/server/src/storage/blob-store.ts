import {
  SqlBlobBytesDriver,
  type BlobBytesDriver,
} from "./blob-bytes-driver.js";
import { DEFAULT_APP_ID } from "../app-id.js";
import { FrickCrossAppAccessError } from "./object-errors.js";
import type { SqlDriver } from "./sql-driver.js";

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
  /** App partition (FR-153); {@link DEFAULT_APP_ID} for single-app servers. */
  appId: string;
  createdAt: string;
}

interface BlobRow {
  tenant_id: string;
  app_id: string;
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
   *
   * App partitioning (FR-153): every method takes a trailing `appId` defaulting
   * to {@link DEFAULT_APP_ID}, so single-app callers are byte-for-byte
   * unaffected. Reads filter by `app_id`; writes stamp it. Because the
   * `blob_metadata` PRIMARY KEY is `blob_id` (app_id is an additive FR-36
   * column, not part of the key) a write from a *different* app to the same
   * blob id would clobber the owning app's row via ON CONFLICT — the
   * cross-app guard in {@link create} rejects that, mirroring ObjectStore.
   */
  constructor(
    private readonly sql: SqlDriver,
    bytes?: BlobBytesDriver,
  ) {
    // Default to the seam-backed bytes driver (blob_content via SqlDriver),
    // which works on SQLite and Postgres alike.
    this.#bytes = bytes ?? new SqlBlobBytesDriver(sql);
  }

  async create(
    tenantId: string,
    metadata: BlobMetadataInput,
    appId: string = DEFAULT_APP_ID,
  ): Promise<void> {
    // Cross-app write guard (FR-153): the PK is `blob_id`, so an ON CONFLICT
    // update from another app would overwrite the owner's row. Reject it.
    const owner = await this.sql.get<{ app_id: string }>(
      "SELECT app_id FROM blob_metadata WHERE blob_id = ?",
      [metadata.blobId],
    );
    if (owner !== undefined && owner.app_id !== appId) {
      throw new FrickCrossAppAccessError({
        requestedAppId: appId,
        ownerAppId: owner.app_id,
        tenantId,
        objectType: "blob_metadata",
        objectId: metadata.blobId,
      });
    }
    await this.sql.run(
      `INSERT INTO blob_metadata
          (app_id, tenant_id, blob_id, owner_id, content_hash, byte_length, mime_type, storage_key, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(blob_id) DO UPDATE SET
            app_id = excluded.app_id,
            tenant_id = excluded.tenant_id,
            owner_id = excluded.owner_id,
            content_hash = excluded.content_hash,
            byte_length = excluded.byte_length,
            mime_type = excluded.mime_type,
            storage_key = excluded.storage_key,
            created_at = excluded.created_at`,
      [
        appId,
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

  async read(
    tenantId: string,
    blobId: string,
    appId: string = DEFAULT_APP_ID,
  ): Promise<BlobMetadata | undefined> {
    const row = await this.sql.get<BlobRow>(
      "SELECT * FROM blob_metadata WHERE app_id = ? AND tenant_id = ? AND blob_id = ?",
      [appId, tenantId, blobId],
    );
    if (!row) {
      return undefined;
    }
    return mapBlobRow(row);
  }

  async list(
    tenantId: string,
    ownerId?: string,
    appId: string = DEFAULT_APP_ID,
  ): Promise<BlobMetadata[]> {
    const rows = ownerId
      ? await this.sql.all<BlobRow>(
          "SELECT * FROM blob_metadata WHERE app_id = ? AND tenant_id = ? AND owner_id = ? ORDER BY created_at DESC, blob_id ASC",
          [appId, tenantId, ownerId],
        )
      : await this.sql.all<BlobRow>(
          "SELECT * FROM blob_metadata WHERE app_id = ? AND tenant_id = ? ORDER BY created_at DESC, blob_id ASC",
          [appId, tenantId],
        );
    return rows.map(mapBlobRow);
  }

  /**
   * Sum the `byte_length` of every blob owned by `(tenantId, ownerId)`. This is
   * the per-principal usage figure the upload route checks against the
   * configured quota (FR-56). The query is app-, tenant- and owner-scoped, so
   * one principal's usage never reflects another principal's, another tenant's,
   * or another app's blobs. Returns `0` when the owner has no blobs.
   */
  async totalBytesForOwner(
    tenantId: string,
    ownerId: string,
    appId: string = DEFAULT_APP_ID,
  ): Promise<number> {
    const row = await this.sql.get<{ total: number | bigint }>(
      "SELECT COALESCE(SUM(byte_length), 0) AS total FROM blob_metadata WHERE app_id = ? AND tenant_id = ? AND owner_id = ?",
      [appId, tenantId, ownerId],
    );
    return row ? Number(row.total) : 0;
  }

  /**
   * Remove a blob's metadata row. Returns true when a row was deleted, false
   * when `(tenantId, blobId)` was already absent — idempotent. Used by the
   * orphaned-blob GC (FR-57); callers MUST also delete the bytes (and any
   * derivatives) via {@link deleteContent}. On the `blob_content` byte backend
   * the metadata→content FK is `ON DELETE CASCADE`, but the filesystem/S3 byte
   * drivers are not cascade-backed, so byte deletion is the caller's job.
   */
  async deleteMetadata(
    tenantId: string,
    blobId: string,
    appId: string = DEFAULT_APP_ID,
  ): Promise<boolean> {
    const result = await this.sql.run(
      "DELETE FROM blob_metadata WHERE app_id = ? AND tenant_id = ? AND blob_id = ?",
      [appId, tenantId, blobId],
    );
    return result.changes > 0;
  }

  /**
   * List every `blob_metadata` row for a tenant, oldest first. Unlike
   * {@link list} (newest-first, owner-filtered, for app reads) this is ordered
   * by `created_at ASC` so the orphaned-blob GC (FR-57) examines the oldest —
   * most likely orphaned — blobs first.
   */
  async listAllOldestFirst(
    tenantId: string,
    appId: string = DEFAULT_APP_ID,
  ): Promise<BlobMetadata[]> {
    const rows = await this.sql.all<BlobRow>(
      "SELECT * FROM blob_metadata WHERE app_id = ? AND tenant_id = ? ORDER BY created_at ASC, blob_id ASC",
      [appId, tenantId],
    );
    return rows.map(mapBlobRow);
  }

  /**
   * Stream `blob_metadata` rows oldest-first in a bounded keyset page, for the
   * orphaned-blob GC (FR-57). Unlike {@link listAllOldestFirst} (which loads the
   * whole tenant into memory and can OOM a large tenant), this returns at most
   * `limit` rows and lets the caller resume from the last `(createdAt, blobId)`
   * cursor — so a GC pass over millions of blobs runs in bounded heap.
   *
   * Pass `cursor` = the `{ createdAt, blobId }` of the last row from the prior
   * page to fetch the next page; omit it for the first page. Ordering matches
   * {@link listAllOldestFirst}: `created_at ASC, blob_id ASC`.
   */
  async listOldestFirstPage(
    tenantId: string,
    limit: number,
    cursor?: { createdAt: string; blobId: string },
    appId: string = DEFAULT_APP_ID,
  ): Promise<BlobMetadata[]> {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1;
    const rows = cursor
      ? await this.sql.all<BlobRow>(
          `SELECT * FROM blob_metadata
              WHERE app_id = ? AND tenant_id = ?
                AND (created_at > ? OR (created_at = ? AND blob_id > ?))
              ORDER BY created_at ASC, blob_id ASC
              LIMIT ?`,
          [appId, tenantId, cursor.createdAt, cursor.createdAt, cursor.blobId, safeLimit],
        )
      : await this.sql.all<BlobRow>(
          `SELECT * FROM blob_metadata
              WHERE app_id = ? AND tenant_id = ?
              ORDER BY created_at ASC, blob_id ASC
              LIMIT ?`,
          [appId, tenantId, safeLimit],
        );
    return rows.map(mapBlobRow);
  }

  /**
   * Return the distinct `app_id`s that own at least one `blob_metadata` row for
   * a tenant. The orphaned-blob GC (FR-57) uses this to fan a sweep out across
   * EVERY app that actually holds blobs — not just {@link DEFAULT_APP_ID} — so a
   * multi-app server reclaims storage for non-default apps too. Returned in
   * ascending app-id order for deterministic iteration.
   */
  async listAppIdsWithBlobs(tenantId: string): Promise<string[]> {
    const rows = await this.sql.all<{ app_id: string }>(
      "SELECT DISTINCT app_id FROM blob_metadata WHERE tenant_id = ? ORDER BY app_id ASC",
      [tenantId],
    );
    return rows.map((row) => row.app_id);
  }

  async writeContent(
    tenantId: string,
    blobId: string,
    content: Uint8Array,
    appId: string = DEFAULT_APP_ID,
  ): Promise<void> {
    await this.#bytes.write(tenantId, blobId, content, appId);
  }

  async readContent(
    tenantId: string,
    blobId: string,
    appId: string = DEFAULT_APP_ID,
  ): Promise<Uint8Array | undefined> {
    return this.#bytes.read(tenantId, blobId, appId);
  }

  async deleteContent(
    tenantId: string,
    blobId: string,
    appId: string = DEFAULT_APP_ID,
  ): Promise<void> {
    await this.#bytes.delete(tenantId, blobId, appId);
  }

  async hasContent(
    tenantId: string,
    blobId: string,
    appId: string = DEFAULT_APP_ID,
  ): Promise<boolean> {
    return this.#bytes.exists(tenantId, blobId, appId);
  }
}

function mapBlobRow(row: BlobRow): BlobMetadata {
  return {
    tenantId: row.tenant_id,
    appId: row.app_id,
    blobId: row.blob_id,
    ownerId: row.owner_id,
    contentHash: row.content_hash,
    byteLength: Number(row.byte_length),
    mimeType: row.mime_type,
    createdAt: row.created_at,
    ...(row.storage_key ? { storageKey: row.storage_key } : {}),
  };
}
