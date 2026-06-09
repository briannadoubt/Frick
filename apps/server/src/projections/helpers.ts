/**
 * Projection-author ergonomics helpers (FR-134).
 *
 * The projections themselves are app logic, but the micro-ergonomics every
 * projection author re-derives over the {@link FrickProjection} API are
 * generic. These are pure DX sugar — no new capability.
 */
import type { PlainObject } from "@fricken/protocol";
import type {
  FrickProjection,
  FrickProjectionContext,
  ProjectionApplyResult,
} from "./registry.js";

/**
 * Typed `ctx.store.listObjects(ctx.tenantId, type, ctx.appId)` — read every
 * object of `type` in the apply/read context's tenant AND app partition, cast
 * to `T`. Saves the `as unknown as T[]` dance in every projection handler.
 *
 * App scoping (FR-153 / tenant-app-isolation-7): the context carries the
 * originating write's `appId`, so a per-app projection reads its OWN app's
 * objects, not the `_default` partition. `ctx.appId` is `undefined` for
 * single-app servers, which the store overload defaults to `_default` — so
 * existing single-app behaviour is byte-for-byte unchanged.
 */
export async function listProjectionObjects<T = PlainObject>(
  ctx: FrickProjectionContext,
  type: string,
): Promise<T[]> {
  return (await ctx.store.listObjects(ctx.tenantId, type, ctx.appId)) as unknown as T[];
}

/**
 * Build a one-row {@link ProjectionApplyResult} — the common case where a
 * projection materializes a single keyed row (e.g. a counts/summary blob)
 * rather than a per-entity set. Equivalent to `{ changes: [{ key, value }] }`.
 */
export function singleChange(key: string, value: PlainObject): ProjectionApplyResult {
  return { changes: [{ key, value }] };
}

/**
 * The distinct object-source types across one or more projections — the set an
 * app bootstraps at boot (e.g. to prime caches or assert schema coverage).
 * Stream sources are ignored; only `{ kind: "object" }` sources contribute.
 */
export function projectionSourceObjectTypes(
  projections: readonly FrickProjection[],
): string[] {
  const types = new Set<string>();
  for (const projection of projections) {
    for (const source of projection.sources) {
      if (source.kind === "object") {
        types.add(source.type);
      }
    }
  }
  return [...types];
}
