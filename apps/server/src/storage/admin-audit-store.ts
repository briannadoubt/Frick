import { createHash, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * One entry in the admin audit log. Rows are appended by the admin route
 * handlers after authentication has succeeded — never for unauthenticated
 * requests, which are request-log territory. The table is global (not
 * tenant-scoped) because admin actions span all tenants and the global admin
 * scope itself; an operator investigating an incident wants a single stream
 * to walk.
 *
 * Migration 0012 added a hash chain over the rows: each row's `entry_hash`
 * commits to the previous row's hash and the canonical JSON of its own
 * columns. Tampering with any row (changing `action`, `target`, etc., or
 * deleting a row) breaks the chain and is detectable via {@link
 * AdminAuditStore.verifyChain}.
 */
export type AdminAuditOutcome = "allow" | "deny" | "error";

export interface AdminAuditRow {
  id: number;
  occurredAt: string;
  /** Truncated SHA-256 of the admin token (hex, 12 chars). Never the raw token. */
  adminTokenFingerprint: string;
  /** Dotted action name, e.g. `tenants.create`, `tenants.archive`. */
  action: string;
  /** Target identifier the action operated on (e.g. tenant id). */
  target?: string;
  outcome: AdminAuditOutcome;
  /** JSON-encoded extra metadata. Callers must redact secrets before passing. */
  detail?: string;
  /** Hash of the chronologically-previous row's `entry_hash`. Empty string for the genesis row. */
  previousHash?: string;
  /** SHA-256 hex over `previousHash || canonical_json(row)`. */
  entryHash?: string;
}

interface AdminAuditSqlRow {
  id: number;
  occurred_at: string;
  admin_token_fingerprint: string;
  action: string;
  target: string | null;
  outcome: string;
  detail: string | null;
  previous_hash: string | null;
  entry_hash: string | null;
}

export interface AdminAuditListOptions {
  /** Inclusive lower bound on `occurredAt` (ISO-8601). */
  since?: string;
  /** Exact-match filter on `action`. */
  action?: string;
  /** Max rows to return. Defaults to 100, capped at 1000. */
  limit?: number;
}

export interface AdminAuditChainVerification {
  valid: boolean;
  /** When `valid` is false, the `id` of the first row whose hash didn't match. */
  brokenAt?: number;
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

/**
 * Canonical JSON for hashing. The key order is fixed so a sort change in the
 * future can't silently invalidate existing chains.
 */
function canonicalJson(row: {
  occurredAt: string;
  adminTokenFingerprint: string;
  action: string;
  target: string | null;
  outcome: string;
  detail: string | null;
}): string {
  return JSON.stringify({
    occurred_at: row.occurredAt,
    admin_token_fingerprint: row.adminTokenFingerprint,
    action: row.action,
    target: row.target,
    outcome: row.outcome,
    detail: row.detail,
  });
}

function computeEntryHash(previousHash: string, canonical: string): string {
  return createHash("sha256").update(previousHash, "utf8").update(canonical, "utf8").digest("hex");
}

/** Constant-time-ish string comparison via timingSafeEqual on equal-length buffers. */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export class AdminAuditStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(input: Omit<AdminAuditRow, "id" | "occurredAt" | "previousHash" | "entryHash">): AdminAuditRow {
    const occurredAt = this.now().toISOString();
    const target = input.target ?? null;
    const detail = input.detail ?? null;

    // Look up the most-recent row's entry_hash to chain against. We order by
    // `id DESC` because `id` is the AUTOINCREMENT insertion order — clock
    // skew on `occurred_at` would otherwise let two rows tie. Empty string
    // for the genesis row keeps the canonical input stable.
    const previousRow = this.db
      .prepare(`SELECT entry_hash FROM admin_audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { entry_hash: string | null } | undefined;
    const previousHash = previousRow?.entry_hash ?? "";

    const canonical = canonicalJson({
      occurredAt,
      adminTokenFingerprint: input.adminTokenFingerprint,
      action: input.action,
      target,
      outcome: input.outcome,
      detail,
    });
    const entryHash = computeEntryHash(previousHash, canonical);

    const result = this.db
      .prepare(
        `INSERT INTO admin_audit_log
           (occurred_at, admin_token_fingerprint, action, target, outcome, detail, previous_hash, entry_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        occurredAt,
        input.adminTokenFingerprint,
        input.action,
        target,
        input.outcome,
        detail,
        previousHash,
        entryHash,
      );
    return {
      id: Number(result.lastInsertRowid),
      occurredAt,
      adminTokenFingerprint: input.adminTokenFingerprint,
      action: input.action,
      ...(input.target !== undefined ? { target: input.target } : {}),
      outcome: input.outcome,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      previousHash,
      entryHash,
    };
  }

  list(options: AdminAuditListOptions = {}): AdminAuditRow[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.since !== undefined) {
      clauses.push("occurred_at >= ?");
      params.push(options.since);
    }
    if (options.action !== undefined) {
      clauses.push("action = ?");
      params.push(options.action);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const requested = options.limit ?? DEFAULT_LIST_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(requested)));
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT id, occurred_at, admin_token_fingerprint, action, target, outcome, detail,
                previous_hash, entry_hash
           FROM admin_audit_log
           ${where}
           ORDER BY occurred_at DESC, id DESC
           LIMIT ?`,
      )
      .all(...params) as unknown as AdminAuditSqlRow[];
    return rows.map(toRow);
  }

  /**
   * Re-derive each row's `entry_hash` in insertion order and compare against
   * the stored value. Returns `{ valid: true }` if the chain is intact, or
   * `{ valid: false, brokenAt: <id> }` for the first row that doesn't match.
   * Rows with a NULL `entry_hash` (pre-chain rows from before migration 0012)
   * are skipped — they form the implicit "genesis" prefix.
   */
  verifyChain(): AdminAuditChainVerification {
    const rows = this.db
      .prepare(
        `SELECT id, occurred_at, admin_token_fingerprint, action, target, outcome, detail,
                previous_hash, entry_hash
           FROM admin_audit_log
           ORDER BY id ASC`,
      )
      .all() as unknown as AdminAuditSqlRow[];

    let previousHash = "";
    let sawHashed = false;
    for (const row of rows) {
      if (row.entry_hash === null) {
        // Pre-chain row — leave `previousHash` at "" so the first hashed row
        // chains from the genesis prefix.
        continue;
      }
      const expectedPrevious = sawHashed ? previousHash : (row.previous_hash ?? "");
      if (sawHashed && !constantTimeEquals(row.previous_hash ?? "", previousHash)) {
        return { valid: false, brokenAt: Number(row.id) };
      }
      const canonical = canonicalJson({
        occurredAt: row.occurred_at,
        adminTokenFingerprint: row.admin_token_fingerprint,
        action: row.action,
        target: row.target,
        outcome: row.outcome,
        detail: row.detail,
      });
      const derived = computeEntryHash(expectedPrevious, canonical);
      if (!constantTimeEquals(derived, row.entry_hash)) {
        return { valid: false, brokenAt: Number(row.id) };
      }
      previousHash = row.entry_hash;
      sawHashed = true;
    }
    return { valid: true };
  }
}

function toRow(row: AdminAuditSqlRow): AdminAuditRow {
  return {
    id: Number(row.id),
    occurredAt: row.occurred_at,
    adminTokenFingerprint: row.admin_token_fingerprint,
    action: row.action,
    ...(row.target !== null ? { target: row.target } : {}),
    outcome: row.outcome as AdminAuditOutcome,
    ...(row.detail !== null ? { detail: row.detail } : {}),
    ...(row.previous_hash !== null ? { previousHash: row.previous_hash } : {}),
    ...(row.entry_hash !== null ? { entryHash: row.entry_hash } : {}),
  };
}
