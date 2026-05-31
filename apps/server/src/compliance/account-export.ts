import {
  objectByName,
  redactRecord,
  type FieldSensitivity,
  type PlainObject,
} from "@frick/protocol";
import type { FrickStore } from "../store.js";
import type { Principal } from "../authz.js";

/**
 * Field names that, by convention, hold the id of the user who owns an object
 * record. The framework has no formal "owner field" marker on {@link ObjectDef}
 * — ownership is expressed as a value inside the record (the same convention
 * blob metadata uses via its `owner_id` column). We treat a record as owned by
 * the principal when ANY of these fields equals `principal.userId`.
 *
 * `ownerId` mirrors the blob convention and is the recommended field name for
 * new schemas; `userId` / `createdBy` cover the common authoring patterns seen
 * in the chat/product schemas. Apps with a different convention can override
 * the set via {@link AccountExportOptions.ownerFields}.
 */
export const DEFAULT_OWNER_FIELDS: readonly string[] = ["ownerId", "userId", "createdBy"];

/**
 * Classifications excluded from a self-service account export. This is the
 * principal's OWN data, so personal (`pii`), conservative-default (`private`),
 * and user-generated (`content`) values are intentionally INCLUDED — the whole
 * point of the export is to hand the user everything they authored. Only
 * `secret`-classified fields (credentials, tokens, internal secrets that may be
 * co-located on an owned record) are masked: a data-subject export should never
 * be a credential-exfiltration vector. See `docs/threat-model.md`.
 */
export const ACCOUNT_EXPORT_REDACTED_SENSITIVITIES: readonly FieldSensitivity[] = ["secret"];

export interface AccountExportOptions {
  /**
   * Override which record fields are consulted to decide ownership. Defaults
   * to {@link DEFAULT_OWNER_FIELDS}. A record is included when any listed field
   * equals the principal's `userId`.
   */
  readonly ownerFields?: readonly string[];
  /**
   * Override which field sensitivities are masked in the export output.
   * Defaults to {@link ACCOUNT_EXPORT_REDACTED_SENSITIVITIES} (only `secret`).
   */
  readonly redact?: readonly FieldSensitivity[];
}

/**
 * The framework-default portion of an account export: every object record the
 * principal owns, grouped by object type, plus the metadata an app needs to
 * interpret it. App-specific data (streams, blob metadata, etc.) is layered on
 * via the {@link ServerOptions.onAccountExport} hook — see {@link AccountExport}.
 */
export interface AccountExportBase {
  tenantId: string;
  userId: string;
  generatedAt: string;
  schemaHash: string;
  /**
   * Owned object records keyed by object type name. Each value is the list of
   * records (including their `id`) owned by the principal within the tenant,
   * with `secret`-classified fields masked. Object types the principal owns no
   * records of are present with an empty array so the shape is stable.
   */
  objects: Record<string, PlainObject[]>;
}

/**
 * Final export bundle returned to the principal. The framework owns
 * {@link AccountExportBase}; the optional `app` slice is whatever the host's
 * {@link ServerOptions.onAccountExport} hook returned (or `undefined` when no
 * hook is registered).
 */
export interface AccountExport extends AccountExportBase {
  app?: unknown;
}

/**
 * App augmentation hook. Called with the resolved {@link Principal} and the
 * framework's {@link AccountExportBase} after the owned-object bundle has been
 * assembled. The returned value (if any) is attached to the export as `app`.
 *
 * The hook MUST scope every read to `principal.tenantId` and `principal.userId`
 * — the framework cannot enforce tenant isolation on app-specific queries it
 * does not know about. The `base` argument is provided read-only so a hook can,
 * e.g., derive blob ids from owned records without re-querying.
 */
export type OnAccountExport = (
  principal: Principal,
  base: AccountExportBase,
) => Promise<unknown> | unknown;

/**
 * Assemble the framework-default account export for `principal`: every object
 * record they own, across every object type in the active schema, within their
 * tenant only.
 *
 * Tenant isolation: object reads go through {@link FrickStore.listObjects} with
 * `principal.tenantId`, which is itself tenant-scoped at the SQL layer, so a
 * record from another tenant can never appear. Owner scoping is applied on top:
 * a record is included only when one of `options.ownerFields` equals
 * `principal.userId`.
 *
 * Sensitivity: `secret`-classified fields are masked (see
 * {@link ACCOUNT_EXPORT_REDACTED_SENSITIVITIES}); the principal's own `pii` /
 * `private` / `content` values are returned in full.
 */
export function buildAccountExportBase(
  store: FrickStore,
  principal: Principal,
  options: AccountExportOptions = {},
): AccountExportBase {
  const ownerFields = options.ownerFields ?? DEFAULT_OWNER_FIELDS;
  const redact = options.redact ?? ACCOUNT_EXPORT_REDACTED_SENSITIVITIES;
  const objects: Record<string, PlainObject[]> = {};

  for (const objectDef of store.schema.objects) {
    const owned = store
      .listObjects(principal.tenantId, objectDef.name)
      .filter((record) => isOwnedBy(record, principal.userId, ownerFields));
    const fields = objectByName(store.schema, objectDef.name).fields;
    objects[objectDef.name] = owned.map((record) =>
      redactRecord(record, fields, { redact }),
    );
  }

  return {
    tenantId: principal.tenantId,
    userId: principal.userId,
    generatedAt: new Date().toISOString(),
    schemaHash: store.schema.hash,
    objects,
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
