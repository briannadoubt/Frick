/**
 * Orphaned-blob garbage collection (FR-57).
 *
 * A blob row in `blob_metadata` is "orphaned" when nothing references it. This
 * job deletes orphaned blobs (metadata + bytes + derivatives) so storage does
 * not grow unbounded as objects that referenced a blob are deleted or rewritten.
 *
 * SAFETY — why this is conservative by construction
 * --------------------------------------------------
 * Deleting user data on a false-negative reference check is unacceptable, so
 * orphan detection is intentionally narrow and multiply-guarded:
 *
 *   (a) OPT-IN ONLY. The job is never registered/scheduled unless an app
 *       explicitly enables it (see `createBlobGcRecurringJob`). A default Frick
 *       server never GCs blobs.
 *
 *   (b) GRACE WINDOW. A blob is only ever eligible once it is older than
 *       `graceMs` (default 7 days). A freshly uploaded blob whose referencing
 *       object has not yet been written (multi-step upload-then-attach flows,
 *       in-flight transactions, client retries) is therefore always kept.
 *
 *   (c) APP `isReferenced` HOOK. The framework only knows about *declared*
 *       blob-ref fields (`kind:'ref'` whose `ref ∈ schema.blobs`). Apps that
 *       store blob ids in UNTYPED `string`/`json` fields can supply an
 *       `isReferenced(blobId)` predicate; any blob it protects is kept. A blob
 *       is deleted only when it is unreferenced by BOTH the declared-ref scan
 *       AND the hook.
 *
 *   (d) DECLARED-REF SCAN ONLY. The framework-known reference set is computed
 *       purely from declared blob-ref fields (via `blobRefFields`). It does NOT
 *       and CANNOT see blob ids hidden in untyped fields — see the
 *       prominently-documented caveat on {@link blobRefFields} and in
 *       CHANGELOG.md. The grace window + hook exist precisely to cover that gap.
 *
 * This mirrors the FR-145 stream-retention stance: blob metadata is the
 * source of truth for user uploads, not a disposable cache, so the framework
 * keeps everything by default and only prunes what an operator has explicitly,
 * conservatively opted into pruning.
 */

import type {
  FrickSchema,
  PlainObject,
} from "@fricken/protocol";
import { blobRefFields } from "@fricken/protocol";
import type { FrickLogger } from "../logger.js";
import type { FrickStore } from "../store.js";
import type { FrickJobHandler, FrickJobResult } from "../jobs/registry.js";
import type { FrickRecurringJob } from "../jobs/recurring.js";
import { eachTenant } from "../jobs/recurring.js";

export const BLOB_GC_JOB_TYPE = "blob.gc";

/** Default grace window: a blob must be at least this old to be GC-eligible. */
export const DEFAULT_BLOB_GC_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Default cadence for the recurring sweep: once per hour. */
export const DEFAULT_BLOB_GC_INTERVAL_MS = 60 * 60 * 1000;

/**
 * App-supplied predicate that reports whether `blobId` is still referenced by
 * something the framework cannot see (typically a blob id stored in an untyped
 * `string`/`json` field). Return `true` to PROTECT the blob from GC. May be
 * async. Called only for blobs already past the grace window and already found
 * to be unreferenced by the declared-ref scan, so it runs on a small set.
 */
export type BlobIsReferencedHook = (args: {
  tenantId: string;
  blobId: string;
}) => boolean | Promise<boolean>;

export interface BlobGcConfig {
  /**
   * Grace window in ms. A blob is eligible for GC only once
   * `now - createdAt >= graceMs`. Defaults to {@link DEFAULT_BLOB_GC_GRACE_MS}
   * (7 days). MUST be `>= 0`.
   */
  graceMs?: number;
  /**
   * Optional app hook to protect blobs referenced via untyped fields. See
   * {@link BlobIsReferencedHook}.
   */
  isReferenced?: BlobIsReferencedHook;
}

export interface RunBlobGcArgs {
  store: FrickStore;
  tenantId: string;
  /** Wall-clock reference for the grace check. Defaults to `Date.now()`. */
  now?: number;
  graceMs?: number;
  isReferenced?: BlobIsReferencedHook;
  logger?: FrickLogger;
  /** When true, compute deletions but do not delete anything. */
  dryRun?: boolean;
}

export interface BlobGcResult {
  /** Blobs examined (every `blob_metadata` row in the tenant). */
  scanned: number;
  /** Blobs kept because they are within the grace window. */
  keptWithinGrace: number;
  /** Blobs kept because a declared blob-ref field referenced them. */
  keptDeclaredRef: number;
  /** Blobs kept because the app `isReferenced` hook protected them. */
  keptHookProtected: number;
  /** Blob ids actually deleted (empty under `dryRun`). */
  deleted: string[];
}

/**
 * Compute the framework-known referenced blob-id set for a tenant: scan every
 * object of every type that declares a blob-ref field and collect the field
 * values. Only declared `kind:'ref' → schema.blobs` fields are consulted (see
 * the caveat on {@link blobRefFields}).
 */
async function collectDeclaredReferencedBlobIds(
  store: FrickStore,
  schema: FrickSchema,
  tenantId: string,
): Promise<Set<string>> {
  const referenced = new Set<string>();
  const fields = blobRefFields(schema);
  if (fields.length === 0) {
    return referenced;
  }
  // Group ref-fields by object type so we list each type at most once.
  const fieldsByObject = new Map<string, string[]>();
  for (const { objectName, field } of fields) {
    const names = fieldsByObject.get(objectName) ?? [];
    names.push(field.name);
    fieldsByObject.set(objectName, names);
  }
  for (const [objectName, fieldNames] of fieldsByObject) {
    const rows: PlainObject[] = await store.objects.list(tenantId, objectName);
    for (const row of rows) {
      for (const fieldName of fieldNames) {
        const value = row[fieldName];
        if (typeof value === "string" && value.length > 0) {
          referenced.add(value);
        }
      }
    }
  }
  return referenced;
}

/**
 * Run one orphaned-blob GC pass for a single tenant. Conservative by design:
 * see the module header. Safe to call directly (unit tests) or from the job
 * handler. Never throws on a missing blob; deletion of bytes + derivatives +
 * metadata is best-effort-consistent (metadata last, so a crash mid-delete
 * leaves a recoverable orphan rather than a dangling metadata row).
 */
export async function runOrphanedBlobGc(args: RunBlobGcArgs): Promise<BlobGcResult> {
  const { store, tenantId } = args;
  const now = args.now ?? Date.now();
  const graceMs = args.graceMs ?? DEFAULT_BLOB_GC_GRACE_MS;
  if (!(graceMs >= 0)) {
    throw new Error(`blob GC graceMs must be >= 0 (got ${graceMs})`);
  }
  const result: BlobGcResult = {
    scanned: 0,
    keptWithinGrace: 0,
    keptDeclaredRef: 0,
    keptHookProtected: 0,
    deleted: [],
  };

  const blobs = await store.blobs.listAllOldestFirst(tenantId);
  result.scanned = blobs.length;
  if (blobs.length === 0) {
    return result;
  }

  // Declared blob-ref set is computed once per pass (one listing per object
  // type that declares a blob-ref field).
  const referenced = await collectDeclaredReferencedBlobIds(store, store.schema, tenantId);

  const graceCutoff = now - graceMs;
  for (const blob of blobs) {
    // (b) Grace window: never touch a blob newer than the cutoff. A blob with
    // an unparseable timestamp is treated as "too new" and kept.
    const createdAtMs = Date.parse(blob.createdAt);
    const withinGrace = !Number.isFinite(createdAtMs) || createdAtMs > graceCutoff;
    if (withinGrace) {
      result.keptWithinGrace += 1;
      continue;
    }
    // (d) Declared-ref scan.
    if (referenced.has(blob.blobId)) {
      result.keptDeclaredRef += 1;
      continue;
    }
    // (c) App hook for untyped-field references.
    if (args.isReferenced) {
      const protectedByHook = await args.isReferenced({ tenantId, blobId: blob.blobId });
      if (protectedByHook) {
        result.keptHookProtected += 1;
        continue;
      }
    }
    // Orphan: unreferenced by BOTH the declared-ref scan and the hook, and
    // outside the grace window.
    if (args.dryRun) {
      result.deleted.push(blob.blobId);
      continue;
    }
    await deleteBlobConsistently(store, tenantId, blob.blobId);
    result.deleted.push(blob.blobId);
  }

  if (result.deleted.length > 0) {
    args.logger?.info("frick.blob.gc.swept", {
      event: "frick.blob.gc.swept",
      tenantId,
      scanned: result.scanned,
      deleted: result.deleted.length,
      keptWithinGrace: result.keptWithinGrace,
      keptDeclaredRef: result.keptDeclaredRef,
      keptHookProtected: result.keptHookProtected,
    });
  }
  return result;
}

/**
 * Delete a blob's bytes, derivatives, and metadata consistently. Order matters:
 * bytes + derivative bytes first, then the metadata row last. If the process
 * crashes mid-delete, a metadata row may still point at already-deleted bytes
 * (a recoverable, re-GC-able orphan) — strictly safer than a dangling
 * `blob_content` row with no metadata, which would never be reclaimed.
 *
 * On the SQLite/Postgres `blob_content` backend the metadata→content FK is
 * `ON DELETE CASCADE`, so deleting metadata also drops the same-table parent
 * bytes; we still call `deleteContent` explicitly because the filesystem/S3
 * byte drivers are NOT cascade-backed and need an explicit delete. Both are
 * idempotent. Derivative *bytes* live inline on the `blob_derivatives` row
 * (not in `blob_content`), so dropping the derivative rows also drops their
 * bytes — no separate byte-driver delete is needed for derivatives.
 */
async function deleteBlobConsistently(
  store: FrickStore,
  tenantId: string,
  blobId: string,
): Promise<void> {
  // Derivatives first: their bytes are stored inline on the row, so a single
  // delete reclaims both. blob_derivatives is NOT FK-cascaded from
  // blob_metadata, so it must be cleaned up explicitly to avoid leaks.
  await store.blobDerivatives.deleteForParent(blobId, tenantId);
  // Parent bytes (explicit so filesystem/S3 byte drivers are covered too).
  await store.blobs.deleteContent(tenantId, blobId);
  // Metadata last — a crash mid-delete leaves a re-GC-able orphan, never a
  // dangling content row with no metadata.
  await store.blobs.deleteMetadata(tenantId, blobId);
}

export interface BlobGcJobHandlerDeps {
  logger: FrickLogger;
  config?: BlobGcConfig;
}

/**
 * Build the `blob.gc` job handler. The recurring scheduler enqueues one job per
 * tenant per window; this handler runs the GC pass for `ctx.tenantId`. Handler
 * failures are non-retryable (a transient DB error simply waits for the next
 * scheduled window — retrying a destructive sweep aggressively is undesirable).
 */
export function createBlobGcJobHandler(deps: BlobGcJobHandlerDeps): FrickJobHandler {
  const { logger, config } = deps;
  const handler: FrickJobHandler = async (ctx) => {
    try {
      const result = await runOrphanedBlobGc({
        store: ctx.store,
        tenantId: ctx.tenantId,
        logger: ctx.logger,
        ...(config?.graceMs !== undefined ? { graceMs: config.graceMs } : {}),
        ...(config?.isReferenced ? { isReferenced: config.isReferenced } : {}),
      });
      return {
        status: "completed",
        result: {
          scanned: result.scanned,
          deleted: result.deleted.length,
          keptWithinGrace: result.keptWithinGrace,
          keptDeclaredRef: result.keptDeclaredRef,
          keptHookProtected: result.keptHookProtected,
        },
      } satisfies FrickJobResult;
    } catch (error) {
      logger.error("frick.blob.gc.failed", {
        event: "frick.blob.gc.failed",
        tenantId: ctx.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: "failed",
        errorCode: "blob.gcError",
        errorMessage: error instanceof Error ? error.message : String(error),
        retryable: false,
      } satisfies FrickJobResult;
    }
  };
  return handler;
}

export interface BlobGcRecurringConfig extends BlobGcConfig {
  /**
   * Sweep cadence in ms. Defaults to {@link DEFAULT_BLOB_GC_INTERVAL_MS} (1h).
   * MUST be `>= 60_000` (enforced by the recurring registry).
   */
  intervalMs?: number;
}

/**
 * Build the opt-in recurring spec that drives orphaned-blob GC across every
 * live tenant. Apps that want GC pass the returned job in
 * `createFrickServer({ recurring: { jobs: [createBlobGcRecurringJob(...)] } })`
 * AND register the `blob.gc` handler. Both wiring steps are deliberate so GC
 * stays off unless an operator explicitly turns it on. See module header for
 * the full safety rationale.
 */
export function createBlobGcRecurringJob(
  config: BlobGcRecurringConfig = {},
): FrickRecurringJob {
  return {
    name: "frick.blob.gc",
    jobType: BLOB_GC_JOB_TYPE,
    intervalMs: config.intervalMs ?? DEFAULT_BLOB_GC_INTERVAL_MS,
    resolveTargets: eachTenant(),
  };
}
