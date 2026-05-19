import type { FrickStore } from "../store.js";

/**
 * GDPR-style "export everything we know about this user" payload. Shape is
 * intentionally a single JSON document so an operator can hand it to a data-
 * subject request handler as-is. Blob content is excluded — only metadata is
 * returned here, and the blob bytes themselves stay behind the existing
 * `/blobs/:id/content` route so operators can verify before transmitting.
 */
export interface DataSubjectExport {
  tenantId: string;
  userId: string;
  generatedAt: string;
  account: Record<string, unknown> | null;
  sessions: Array<Record<string, unknown>>;
  pushRegistrations: Array<Record<string, unknown>>;
  blobs: Array<Record<string, unknown>>;
}

/**
 * Walk every framework-owned table that may store data about `userId` within
 * `tenantId` and return a single export document. App schemas own their own
 * product data export semantics through extension points.
 */
export function exportDataSubject(
  store: FrickStore,
  tenantId: string,
  userId: string,
): DataSubjectExport {
  const db = store.db;

  const account = db
    .prepare(
      `SELECT user_id, tenant_id, handle, display_name, created_at
         FROM auth_accounts WHERE tenant_id = ? AND user_id = ?`,
    )
    .get(tenantId, userId) as Record<string, unknown> | undefined;

  const sessions = db
    .prepare(
      `SELECT user_id, device_id, replica_id, expires_at, created_at, last_seen_at
         FROM auth_sessions WHERE tenant_id = ? AND user_id = ?
         ORDER BY created_at ASC`,
    )
    .all(tenantId, userId) as Array<Record<string, unknown>>;

  const pushRegistrations = db
    .prepare(
      `SELECT registration_id, device_id, platform, environment, created_at, last_seen_at, revoked_at
         FROM push_device_registrations WHERE tenant_id = ? AND user_id = ?
         ORDER BY created_at ASC`,
    )
    .all(tenantId, userId) as Array<Record<string, unknown>>;

  const blobs = db
    .prepare(
      `SELECT blob_id, content_hash, byte_length, mime_type, storage_key, created_at
         FROM blob_metadata WHERE tenant_id = ? AND owner_id = ?
         ORDER BY created_at ASC`,
    )
    .all(tenantId, userId) as Array<Record<string, unknown>>;

  return {
    tenantId,
    userId,
    generatedAt: new Date().toISOString(),
    account: account ?? null,
    sessions,
    pushRegistrations,
    blobs,
  };
}
