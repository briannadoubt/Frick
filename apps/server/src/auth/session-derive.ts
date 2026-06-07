/**
 * Derive a sibling session in another tenant (FR-131).
 *
 * Frick sessions are bound to a single tenant. Apps that partition data per
 * tenant need to "switch the caller's active tenant" — which means minting a
 * NEW session scoped to the target tenant while reusing the caller's device /
 * replica identity and userId. That re-mint + `tenant.ensure` machinery is
 * generic and belongs in the layer that owns sessions and the tenant ledger;
 * only the membership/authorization decision is app-specific, and stays with
 * the caller (run it before calling this).
 */
import { randomBytes } from "node:crypto";
import type { FrickStore } from "../store.js";
import type { StoredSession } from "../storage/session-store.js";

/** Thrown when the source session token has no live (unexpired) session. */
export class SourceSessionNotActiveError extends Error {
  readonly reason = "sourceSessionNotActive";
  constructor() {
    super("The source session is missing or expired");
    this.name = "SourceSessionNotActiveError";
  }
}

export interface DeriveSiblingSessionOptions {
  /**
   * The caller's current (live) session token. Its `userId`, `deviceId`, and
   * `replicaId` are reused for the derived session.
   */
  fromSessionToken: string;
  /** Tenant the derived session is scoped to. */
  tenantId: string;
  /** Lifetime of the derived session, in seconds. Must be positive. */
  ttlSeconds: number;
  /**
   * Whether to register `tenantId` in the tenant ledger via
   * `store.tenants.ensure` before minting. Defaults to `true`.
   */
  ensureTenant?: boolean;
  /** Override the new-token generator. Defaults to 32 random bytes, hex. */
  tokenFactory?: () => string;
  /** Override `now` for deterministic tests. */
  now?: () => Date;
}

function defaultToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Mint a new session for the same user/device as `fromSessionToken` but scoped
 * to `tenantId`, returning the {@link StoredSession} (including the fresh
 * `sessionToken`). Throws {@link SourceSessionNotActiveError} when the source
 * token has no live session — surface that as `401` so a client can't switch
 * on a dead token.
 *
 * Authorization (e.g. "is this user a member of the target tenant?") is the
 * caller's responsibility and must run BEFORE this call.
 */
export function deriveSiblingSession(
  store: FrickStore,
  options: DeriveSiblingSessionOptions,
): StoredSession {
  if (!(options.ttlSeconds > 0) || !Number.isFinite(options.ttlSeconds)) {
    throw new RangeError(`ttlSeconds must be a positive number, got ${options.ttlSeconds}`);
  }
  const current = store.readActiveSession(options.fromSessionToken);
  if (!current) {
    throw new SourceSessionNotActiveError();
  }
  if (options.ensureTenant !== false) {
    store.tenants.ensure(options.tenantId);
  }
  const now = (options.now ?? (() => new Date()))();
  const expiresAt = new Date(now.getTime() + options.ttlSeconds * 1000).toISOString();
  const sessionToken = (options.tokenFactory ?? defaultToken)();
  return store.createSession({
    sessionToken,
    userId: current.userId,
    deviceId: current.deviceId,
    replicaId: current.replicaId,
    expiresAt,
    tenantId: options.tenantId,
  });
}
