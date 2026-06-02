import type { PlainObject } from "@fricken/protocol";
import type { FrickStore } from "../store.js";
import type { Principal } from "../authz.js";
import { DEFAULT_OWNER_FIELDS } from "./account-export.js";

export interface AccountDeleteOptions {
  /**
   * Override which record fields are consulted to decide ownership. Defaults
   * to {@link DEFAULT_OWNER_FIELDS} (the same set the account export uses). A
   * record is deleted when any listed field equals the principal's `userId`.
   */
  readonly ownerFields?: readonly string[];
}

/**
 * Summary of the framework-default portion of an account deletion. Returned to
 * the caller so the route can report counts and the audit row can record what
 * was removed. App-specific cascades happen in {@link OnAccountDelete} and are
 * not reflected here.
 */
export interface AccountDeleteResult {
  tenantId: string;
  userId: string;
  deletedAt: string;
  /** Whether an `auth_accounts` row existed and was removed. */
  accountDeleted: boolean;
  /** Number of `auth_sessions` rows removed for the principal in this tenant. */
  deletedSessions: number;
  /**
   * Number of owned object rows removed, keyed by object type name. Object
   * types the principal owned no records of are present with `0` so the shape
   * is stable and mirrors {@link AccountExportBase.objects}.
   */
  deletedObjects: Record<string, number>;
}

/**
 * App cascade hook. Called with the resolved {@link Principal} and the
 * framework's {@link AccountDeleteResult} AFTER the framework has removed the
 * principal's owned object rows, sessions, and account record. The hook is the
 * place to delete app-specific data the framework does not know about (stream
 * history, blob content, derived projections, third-party records, etc.).
 *
 * The hook MUST scope every delete it performs to `principal.tenantId` and
 * `principal.userId` — the framework cannot enforce tenant isolation on
 * app-specific tables it does not know about. It runs within the request and
 * may be async; a throw surfaces as an `account_delete_rejected` error to the
 * caller (the framework-default deletion has already committed by then, so keep
 * cascades idempotent).
 */
export type OnAccountDelete = (
  principal: Principal,
  result: AccountDeleteResult,
) => Promise<void> | void;

/**
 * Perform the framework-default account deletion for `principal`: remove every
 * object record they own (across every object type in the active schema, within
 * their tenant only), every session row for the principal in their tenant, and
 * their `auth_accounts` row.
 *
 * Tenant isolation: object reads/deletes go through {@link FrickStore} with
 * `principal.tenantId`, which is tenant-scoped at the SQL layer, so a record
 * from another tenant can never be touched. Owner scoping is applied on top: a
 * record is deleted only when one of `options.ownerFields` equals
 * `principal.userId` — exactly mirroring {@link buildAccountExportBase}. Session
 * and account deletes are scoped to `(userId, tenantId)`.
 *
 * The caller is responsible for invoking the {@link OnAccountDelete} hook (so
 * the order — framework data first, then app cascade — is explicit and the hook
 * can read the returned counts) and for closing any live gateway connections.
 */
export function deleteAccountData(
  store: FrickStore,
  principal: Principal,
  options: AccountDeleteOptions = {},
): AccountDeleteResult {
  const ownerFields = options.ownerFields ?? DEFAULT_OWNER_FIELDS;
  const deletedObjects: Record<string, number> = {};

  for (const objectDef of store.schema.objects) {
    const owned = store
      .listObjects(principal.tenantId, objectDef.name)
      .filter((record) => isOwnedBy(record, principal.userId, ownerFields));
    let removed = 0;
    for (const record of owned) {
      const id = record.id;
      if (typeof id !== "string") {
        continue;
      }
      if (store.deleteObject(principal.tenantId, objectDef.name, id)) {
        removed += 1;
      }
    }
    deletedObjects[objectDef.name] = removed;
  }

  // Sessions before the account row: once the account is gone the principal can
  // no longer authenticate anyway, but removing sessions first keeps the
  // invariant that a live session never points at a missing account.
  const deletedSessions = store.deleteSessionsForUser(
    principal.userId,
    principal.tenantId,
  );
  const accountDeleted = store.deleteAccount(principal.tenantId, principal.userId);

  return {
    tenantId: principal.tenantId,
    userId: principal.userId,
    deletedAt: new Date().toISOString(),
    accountDeleted,
    deletedSessions,
    deletedObjects,
  };
}

function isOwnedBy(
  record: PlainObject,
  userId: string,
  ownerFields: readonly string[],
): boolean {
  for (const field of ownerFields) {
    if (record[field] === userId) {
      return true;
    }
  }
  return false;
}
