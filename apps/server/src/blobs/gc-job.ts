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
import { DEFAULT_APP_ID } from "../app-id.js";
import type { FrickLogger } from "../logger.js";
import type { FrickStore } from "../store.js";
import type { BlobMetadata } from "../storage/blob-store.js";
import type { FrickJobContext, FrickJobHandler, FrickJobResult } from "../jobs/registry.js";
import type { FrickRecurringJob } from "../jobs/recurring.js";

export const BLOB_GC_JOB_TYPE = "blob.gc";

/** Default grace window: a blob must be at least this old to be GC-eligible. */
export const DEFAULT_BLOB_GC_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Default cadence for the recurring sweep: once per hour. */
export const DEFAULT_BLOB_GC_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Default number of `blob_metadata` rows scanned per page. The GC streams the
 * tenant's blobs in pages of this size instead of loading every row into a
 * single array, so a tenant with millions of blobs cannot OOM the worker
 * (finding blob-gc-4). Tunable via {@link RunBlobGcArgs.pageSize}.
 */
export const DEFAULT_BLOB_GC_PAGE_SIZE = 500;

/**
 * App-supplied predicate that reports whether `blobId` is still referenced by
 * something the framework cannot see (typically a blob id stored in an untyped
 * `string`/`json` field). Return `true` to PROTECT the blob from GC. May be
 * async. Called only for blobs already past the grace window and already found
 * to be unreferenced by the declared-ref scan, so it runs on a small set.
 *
 * FAIL-SAFE CONTRACT: the GC only deletes when this hook returns the EXPLICIT
 * boolean `false`. Any other outcome — `true`, `undefined`/`null`, a non-bool,
 * or a thrown error — is treated as "referenced/unknown → keep the blob". A
 * subtle app bug (a forgotten `return`) must never cause data loss.
 */
export type BlobIsReferencedHook = (args: {
  tenantId: string;
  /** App partition the blob lives in (FR-153). {@link DEFAULT_APP_ID} for single-app servers. */
  appId: string;
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
  /**
   * App partition to sweep (FR-153). Defaults to {@link DEFAULT_APP_ID}. The GC
   * is always scoped to a single (tenant, app); the recurring sweep fans out one
   * pass per app that actually holds blobs (see {@link createBlobGcRecurringJob}).
   */
  appId?: string;
  /** Wall-clock reference for the grace check. Defaults to `Date.now()`. */
  now?: number;
  graceMs?: number;
  isReferenced?: BlobIsReferencedHook;
  logger?: FrickLogger;
  /**
   * Rows scanned per page. Defaults to {@link DEFAULT_BLOB_GC_PAGE_SIZE}. The
   * scan is keyset-paginated so heap stays bounded regardless of tenant size.
   */
  pageSize?: number;
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
  appId: string,
): Promise<Set<string>> {
  const referenced = new Set<string>();
  const grouped = groupBlobRefFieldsByObject(schema);
  for (const [objectName, fieldNames] of grouped) {
    const rows: PlainObject[] = await store.objects.list(tenantId, objectName, appId);
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

/** Group declared blob-ref fields by object type so each type is listed once. */
function groupBlobRefFieldsByObject(schema: FrickSchema): Map<string, string[]> {
  const fieldsByObject = new Map<string, string[]>();
  for (const { objectName, field } of blobRefFields(schema)) {
    const names = fieldsByObject.get(objectName) ?? [];
    names.push(field.name);
    fieldsByObject.set(objectName, names);
  }
  return fieldsByObject;
}

/**
 * Targeted re-scan: is THIS one `blobId` referenced by any declared blob-ref
 * field right now? Used as the TOCTOU re-check immediately before deletion
 * (finding blob-gc-3): the pass-level reference set is a snapshot, so a blob
 * that was unreferenced when the page was scanned may have been re-attached to
 * a freshly written object before the loop reached it. Re-querying the live
 * object state at delete time closes that window.
 */
async function isDeclaredReferencedNow(
  store: FrickStore,
  schema: FrickSchema,
  tenantId: string,
  appId: string,
  blobId: string,
): Promise<boolean> {
  const grouped = groupBlobRefFieldsByObject(schema);
  for (const [objectName, fieldNames] of grouped) {
    const rows: PlainObject[] = await store.objects.list(tenantId, objectName, appId);
    for (const row of rows) {
      for (const fieldName of fieldNames) {
        if (row[fieldName] === blobId) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Resolve the {@link BlobIsReferencedHook} into a FAIL-SAFE keep decision
 * (finding blob-gc-6). The blob is eligible for deletion ONLY when the hook
 * returns the explicit boolean `false`. Every other outcome — `true`, a
 * non-boolean (`undefined`/`null`/`0`/`''`), or a thrown error — is treated as
 * "protected / unknown → keep". Never the reverse: a buggy hook must not cause
 * data loss.
 *
 * @returns `true` when the blob is protected (keep), `false` only when the hook
 *   explicitly returned `false` (safe to delete as far as the hook is concerned).
 */
async function hookProtects(
  hook: BlobIsReferencedHook,
  args: { tenantId: string; appId: string; blobId: string },
  logger: FrickLogger | undefined,
): Promise<boolean> {
  let outcome: unknown;
  try {
    outcome = await hook(args);
  } catch (error) {
    // A throwing hook is "unknown" — fail safe toward keeping the blob.
    logger?.warn("frick.blob.gc.hook_threw", {
      event: "frick.blob.gc.hook_threw",
      tenantId: args.tenantId,
      appId: args.appId,
      blobId: args.blobId,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
  if (outcome === false) {
    return false; // explicit, strict false → not protected by the hook.
  }
  if (outcome !== true) {
    // Non-boolean return (undefined/null/0/''/object) — an app bug. Keep, and
    // surface it so the bug is visible rather than silently deleting data.
    logger?.warn("frick.blob.gc.hook_non_boolean", {
      event: "frick.blob.gc.hook_non_boolean",
      tenantId: args.tenantId,
      appId: args.appId,
      blobId: args.blobId,
      returnedType: outcome === null ? "null" : typeof outcome,
    });
  }
  return true;
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
  const appId = args.appId ?? DEFAULT_APP_ID;
  const now = args.now ?? Date.now();
  const graceMs = args.graceMs ?? DEFAULT_BLOB_GC_GRACE_MS;
  if (!(graceMs >= 0)) {
    throw new Error(`blob GC graceMs must be >= 0 (got ${graceMs})`);
  }
  const pageSize =
    args.pageSize !== undefined && Number.isFinite(args.pageSize) && args.pageSize > 0
      ? Math.floor(args.pageSize)
      : DEFAULT_BLOB_GC_PAGE_SIZE;
  const result: BlobGcResult = {
    scanned: 0,
    keptWithinGrace: 0,
    keptDeclaredRef: 0,
    keptHookProtected: 0,
    deleted: [],
  };

  // Declared blob-ref set is computed once per pass (one listing per object
  // type that declares a blob-ref field), scoped to THIS app. It is a snapshot:
  // the per-blob TOCTOU re-check below re-validates against live state right
  // before any delete (finding blob-gc-3).
  const referenced = await collectDeclaredReferencedBlobIds(store, store.schema, tenantId, appId);

  const graceCutoff = now - graceMs;
  // Keyset-paginated scan (finding blob-gc-4): stream blobs oldest-first in
  // bounded pages instead of materializing the whole tenant in heap.
  let cursor: { createdAt: string; blobId: string } | undefined;
  for (;;) {
    const page: BlobMetadata[] = await store.blobs.listOldestFirstPage(
      tenantId,
      pageSize,
      cursor,
      appId,
    );
    if (page.length === 0) {
      break;
    }
    for (const blob of page) {
      result.scanned += 1;
      // (b) Grace window: never touch a blob newer than the cutoff. A blob with
      // an unparseable timestamp is treated as "too new" and kept.
      const createdAtMs = Date.parse(blob.createdAt);
      const withinGrace = !Number.isFinite(createdAtMs) || createdAtMs > graceCutoff;
      if (withinGrace) {
        result.keptWithinGrace += 1;
        continue;
      }
      // (d) Declared-ref scan (snapshot).
      if (referenced.has(blob.blobId)) {
        result.keptDeclaredRef += 1;
        continue;
      }
      // (c) App hook for untyped-field references — fail-safe (finding blob-gc-6):
      // only an explicit `false` clears the hook guard; anything else keeps.
      if (args.isReferenced) {
        const protectedByHook = await hookProtects(
          args.isReferenced,
          { tenantId, appId, blobId: blob.blobId },
          args.logger,
        );
        if (protectedByHook) {
          result.keptHookProtected += 1;
          continue;
        }
      }
      // Candidate orphan. Under dryRun, report without the destructive
      // re-validation (no delete to guard).
      if (args.dryRun) {
        result.deleted.push(blob.blobId);
        continue;
      }
      // TOCTOU re-check (finding blob-gc-3): the snapshot above can be stale —
      // an aged orphan may have been re-attached to a freshly written object
      // since the page was scanned. Immediately before deleting, re-verify the
      // blob is STILL (1) present, (2) past the grace window, (3) unreferenced
      // by the live declared-ref scan, and (4) not hook-protected. If any guard
      // now holds, skip the delete (fail safe toward keeping data).
      const decision = await recheckOrphanBeforeDelete({
        store,
        tenantId,
        appId,
        blob,
        graceCutoff,
        ...(args.isReferenced ? { isReferenced: args.isReferenced } : {}),
        logger: args.logger,
      });
      if (decision === "keptDeclaredRef") {
        result.keptDeclaredRef += 1;
        continue;
      }
      if (decision === "keptHookProtected") {
        result.keptHookProtected += 1;
        continue;
      }
      if (decision === "keptWithinGrace" || decision === "gone") {
        // Re-attached-then-aged is impossible (grace only grows), and "gone"
        // means another actor already removed it. Either way: skip.
        if (decision === "keptWithinGrace") result.keptWithinGrace += 1;
        continue;
      }
      await deleteBlobConsistently(store, tenantId, blob.blobId, appId);
      result.deleted.push(blob.blobId);
    }
    const last = page[page.length - 1];
    if (last === undefined || page.length < pageSize) {
      break;
    }
    cursor = { createdAt: last.createdAt, blobId: last.blobId };
  }

  if (result.deleted.length > 0) {
    args.logger?.info("frick.blob.gc.swept", {
      event: "frick.blob.gc.swept",
      tenantId,
      appId,
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
 * The destructive-step re-validation for one candidate orphan (finding
 * blob-gc-3). Run as close to the delete as possible, it re-reads LIVE state so
 * a blob re-referenced after the pass snapshot is never deleted. Returns the
 * reason to KEEP the blob, or `"delete"` when every guard still says orphan.
 */
async function recheckOrphanBeforeDelete(args: {
  store: FrickStore;
  tenantId: string;
  appId: string;
  blob: BlobMetadata;
  graceCutoff: number;
  isReferenced?: BlobIsReferencedHook;
  logger: FrickLogger | undefined;
}): Promise<
  "delete" | "gone" | "keptWithinGrace" | "keptDeclaredRef" | "keptHookProtected"
> {
  const { store, tenantId, appId, blob, graceCutoff } = args;
  // (1) Still present? A concurrent delete may have removed it.
  const current = await store.blobs.read(tenantId, blob.blobId, appId);
  if (!current) {
    return "gone";
  }
  // (2) Still past grace? createdAt is immutable, but re-check defensively so an
  // unparseable/now-fresher row is never deleted.
  const createdAtMs = Date.parse(current.createdAt);
  if (!Number.isFinite(createdAtMs) || createdAtMs > graceCutoff) {
    return "keptWithinGrace";
  }
  // (3) Re-scan declared refs for THIS blob against live object state.
  if (await isDeclaredReferencedNow(store, store.schema, tenantId, appId, blob.blobId)) {
    return "keptDeclaredRef";
  }
  // (4) Re-consult the hook (fail-safe) as the final guard for untyped refs.
  if (args.isReferenced) {
    const protectedByHook = await hookProtects(
      args.isReferenced,
      { tenantId, appId, blobId: blob.blobId },
      args.logger,
    );
    if (protectedByHook) {
      return "keptHookProtected";
    }
  }
  return "delete";
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
  appId: string = DEFAULT_APP_ID,
): Promise<void> {
  // Derivatives first: their bytes are stored inline on the row, so a single
  // delete reclaims both. blob_derivatives is NOT FK-cascaded from
  // blob_metadata, so it must be cleaned up explicitly to avoid leaks.
  await store.blobDerivatives.deleteForParent(blobId, tenantId);
  // Parent bytes (explicit so filesystem/S3 byte drivers are covered too),
  // scoped to the owning app (FR-153) so a multi-app sweep stays in-app.
  await store.blobs.deleteContent(tenantId, blobId, appId);
  // Metadata last — a crash mid-delete leaves a re-GC-able orphan, never a
  // dangling content row with no metadata.
  await store.blobs.deleteMetadata(tenantId, blobId, appId);
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
  const handler: FrickJobHandler = async (ctx: FrickJobContext) => {
    try {
      const result = await runOrphanedBlobGc({
        store: ctx.store,
        tenantId: ctx.tenantId,
        // App scoping (FR-153): the worker stamps `ctx.appId` from the job row,
        // so a per-app blob.gc job sweeps its OWN app, not just `_default`
        // (findings blob-gc-2 / tenant-app-isolation-6).
        appId: ctx.appId ?? DEFAULT_APP_ID,
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
 * live tenant AND every app that holds blobs (FR-153, findings blob-gc-2 /
 * tenant-app-isolation-6). Apps that want GC pass the returned job in
 * `createFrickServer({ recurring: { jobs: [createBlobGcRecurringJob(...)] } })`
 * AND register the `blob.gc` handler. Both wiring steps are deliberate so GC
 * stays off unless an operator explicitly turns it on. See module header for
 * the full safety rationale.
 *
 * Fan-out: one job per (tenant, app) per window. For each live tenant the
 * resolver enumerates the distinct `app_id`s that actually own a blob (via
 * {@link BlobStore.listAppIdsWithBlobs}); a tenant with no blobs yet still gets
 * one default-app job so the behavior is unchanged for single-app servers.
 */
export function createBlobGcRecurringJob(
  config: BlobGcRecurringConfig = {},
): FrickRecurringJob {
  return {
    name: "frick.blob.gc",
    jobType: BLOB_GC_JOB_TYPE,
    intervalMs: config.intervalMs ?? DEFAULT_BLOB_GC_INTERVAL_MS,
    resolveTargets: async ({ store }) => {
      const tenants = await store.tenants.list(false);
      const targets: Array<{ tenantId: string; appId: string }> = [];
      for (const tenant of tenants) {
        const appIds = await store.blobs.listAppIdsWithBlobs(tenant.tenantId);
        // No blobs yet → still emit a default-app pass (cheap no-op) so a fresh
        // tenant's behavior matches the historical per-tenant sweep.
        const apps = appIds.length > 0 ? appIds : [DEFAULT_APP_ID];
        for (const appId of apps) {
          targets.push({ tenantId: tenant.tenantId, appId });
        }
      }
      return targets;
    },
  };
}
