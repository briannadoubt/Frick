import type { DatabaseSync } from "node:sqlite";

/**
 * One entry in the admin audit log. Rows are appended by the admin route
 * handlers after authentication has succeeded — never for unauthenticated
 * requests, which are request-log territory. The table is global (not
 * tenant-scoped) because admin actions span all tenants and the global admin
 * scope itself; an operator investigating an incident wants a single stream
 * to walk.
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
}

interface AdminAuditSqlRow {
  id: number;
  occurred_at: string;
  admin_token_fingerprint: string;
  action: string;
  target: string | null;
  outcome: string;
  detail: string | null;
}

export interface AdminAuditListOptions {
  /** Inclusive lower bound on `occurredAt` (ISO-8601). */
  since?: string;
  /** Exact-match filter on `action`. */
  action?: string;
  /** Max rows to return. Defaults to 100, capped at 1000. */
  limit?: number;
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

export class AdminAuditStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(input: Omit<AdminAuditRow, "id" | "occurredAt">): AdminAuditRow {
    const occurredAt = this.now().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO admin_audit_log
           (occurred_at, admin_token_fingerprint, action, target, outcome, detail)
           VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        occurredAt,
        input.adminTokenFingerprint,
        input.action,
        input.target ?? null,
        input.outcome,
        input.detail ?? null,
      );
    return {
      id: Number(result.lastInsertRowid),
      occurredAt,
      adminTokenFingerprint: input.adminTokenFingerprint,
      action: input.action,
      ...(input.target !== undefined ? { target: input.target } : {}),
      outcome: input.outcome,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
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
        `SELECT id, occurred_at, admin_token_fingerprint, action, target, outcome, detail
           FROM admin_audit_log
           ${where}
           ORDER BY occurred_at DESC, id DESC
           LIMIT ?`,
      )
      .all(...params) as unknown as AdminAuditSqlRow[];
    return rows.map(toRow);
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
  };
}
