/**
 * Storage for push-notification device registrations.
 *
 * One row per `(tenantId, userId, deviceId, platform)` active registration —
 * uniqueness is enforced by the partial unique index in migration 0007 (only
 * over rows where `revoked_at IS NULL`). `register` is upsert-by-reactivation:
 * if an active row already exists for the tuple, the token / lastSeenAt are
 * refreshed in place; if a revoked row exists, a new active row is created
 * (leaving the tombstone in place for forensic queries).
 *
 * The rationale for keeping tombstones: APNs / FCM revocation receipts arrive
 * asynchronously, and operators benefit from being able to grep "was this
 * token ever registered to this user" even after a logout. The partial unique
 * index keeps the active-row constraint tight without burying old tombstones.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type PushPlatform = "apns" | "fcm" | "webPush" | "test";
export type PushEnvironment = "production" | "sandbox";

export interface PushDeviceRegistration {
  registrationId: string;
  tenantId: string;
  userId: string;
  deviceId: string;
  platform: PushPlatform;
  token: string;
  environment: PushEnvironment;
  createdAt: string;
  lastSeenAt: string;
  revokedAt?: string;
}

export type PushRegistrationInput = Omit<
  PushDeviceRegistration,
  "registrationId" | "createdAt" | "lastSeenAt" | "revokedAt"
>;

interface RawRow {
  registration_id: string;
  tenant_id: string;
  user_id: string;
  device_id: string;
  platform: string;
  token: string;
  environment: string;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
}

export const PUSH_PLATFORMS: readonly PushPlatform[] = ["apns", "fcm", "webPush", "test"];

export function isPushPlatform(value: string): value is PushPlatform {
  return (PUSH_PLATFORMS as readonly string[]).includes(value);
}

export class PushRegistrationStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Register a device, reactivating-or-refreshing semantics:
   *
   *   - If an active (non-revoked) row already exists for `(tenant, user,
   *     device, platform)`, the token / environment / lastSeenAt are refreshed
   *     in place and that row is returned. The `registration_id` stays stable
   *     so callers that stored a registration id earlier can still revoke it
   *     by id.
   *   - Otherwise a brand-new row is inserted with a fresh `registration_id`.
   *
   * This is the simpler of the two upsert flavours: the alternative would be
   * "reactivate the tombstoned row by clearing `revoked_at`", but that loses
   * the original revocation timestamp. Keeping tombstones intact preserves
   * audit history at the cost of one extra row per re-registration cycle.
   */
  register(input: PushRegistrationInput): PushDeviceRegistration {
    const existing = this.findActive(
      input.tenantId,
      input.userId,
      input.deviceId,
      input.platform,
    );
    const now = new Date().toISOString();
    if (existing) {
      this.db
        .prepare(
          `UPDATE push_device_registrations
             SET token = ?, environment = ?, last_seen_at = ?
             WHERE registration_id = ?`,
        )
        .run(input.token, input.environment, now, existing.registrationId);
      return { ...existing, token: input.token, environment: input.environment, lastSeenAt: now };
    }

    const registrationId = `push-${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO push_device_registrations
            (registration_id, tenant_id, user_id, device_id, platform, token,
             environment, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        registrationId,
        input.tenantId,
        input.userId,
        input.deviceId,
        input.platform,
        input.token,
        input.environment,
        now,
        now,
      );
    return {
      registrationId,
      tenantId: input.tenantId,
      userId: input.userId,
      deviceId: input.deviceId,
      platform: input.platform,
      token: input.token,
      environment: input.environment,
      createdAt: now,
      lastSeenAt: now,
    };
  }

  /**
   * Soft-revoke a registration. Idempotent: revoking an already-revoked row
   * leaves the existing `revoked_at` timestamp in place. Tenant-scoped so an
   * admin in tenant-a can't tombstone tenant-b's registrations.
   *
   * Returns `true` when a row was actually moved into the revoked state on
   * this call (i.e. it was active before). Returns `false` when no such row
   * existed or it was already revoked.
   */
  revoke(registrationId: string, tenantId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE push_device_registrations
            SET revoked_at = ?
            WHERE registration_id = ? AND tenant_id = ? AND revoked_at IS NULL`,
      )
      .run(now, registrationId, tenantId);
    return Number(result.changes ?? 0) > 0;
  }

  /** Look up by id, scoped to a tenant. Returns `undefined` if absent. */
  getById(registrationId: string, tenantId: string): PushDeviceRegistration | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM push_device_registrations
          WHERE registration_id = ? AND tenant_id = ?
          LIMIT 1`,
      )
      .get(registrationId, tenantId) as RawRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  /** Active rows for a user, ordered by creation. */
  listByUser(tenantId: string, userId: string): PushDeviceRegistration[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM push_device_registrations
          WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL
          ORDER BY created_at ASC`,
      )
      .all(tenantId, userId) as RawRow[];
    return rows.map(mapRow);
  }

  /** Bump `last_seen_at` on a row — used after a successful delivery. */
  touch(registrationId: string, tenantId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE push_device_registrations
            SET last_seen_at = ?
            WHERE registration_id = ? AND tenant_id = ?`,
      )
      .run(now, registrationId, tenantId);
  }

  private findActive(
    tenantId: string,
    userId: string,
    deviceId: string,
    platform: PushPlatform,
  ): PushDeviceRegistration | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM push_device_registrations
          WHERE tenant_id = ? AND user_id = ? AND device_id = ? AND platform = ?
            AND revoked_at IS NULL
          LIMIT 1`,
      )
      .get(tenantId, userId, deviceId, platform) as RawRow | undefined;
    return row ? mapRow(row) : undefined;
  }
}

function mapRow(row: RawRow): PushDeviceRegistration {
  const out: PushDeviceRegistration = {
    registrationId: row.registration_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    deviceId: row.device_id,
    platform: row.platform as PushPlatform,
    token: row.token,
    environment: row.environment as PushEnvironment,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
  if (row.revoked_at) out.revokedAt = row.revoked_at;
  return out;
}
