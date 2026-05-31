import type { PlainObject } from "@frick/protocol";
import type { FrickLogger } from "../logger.js";
import type { FrickStore } from "../store.js";

/**
 * A registered "projection" derives an app-readable view from one or more
 * source write streams (object upserts/deletes, stream appends). The
 * an app-owned inbox, activity feed, or leaderboard can watch stream events
 * and object upserts to maintain its own read model.
 *
 * A registered projection exposes an optional `read(ctx, query)` method that
 * the framework wires up at `GET /projections/:name` for HTTP reads, and
 * (since FR-109) streams live row changes to subscribed clients over the
 * sync gateway as `ProjectionDelta` frames. The registry materializes a
 * tenant-scoped copy of every row change a handler declares so the gateway
 * can serve an initial snapshot when a client subscribes. See the
 * projections design note in `docs/operations.md`.
 */

export interface FrickProjectionSourceObject {
  kind: "object";
  /** Object type name; the projection's handler receives writes/deletes. */
  type: string;
}

export interface FrickProjectionSourceStream {
  kind: "stream";
  /** Stream type name; handler receives appended events. */
  type: string;
}

export type FrickProjectionSource =
  | FrickProjectionSourceObject
  | FrickProjectionSourceStream;

export interface FrickProjectionWriteEvent {
  kind: "objectUpsert" | "objectDelete" | "streamEvent";
  tenantId: string;
  /** For `objectUpsert` / `objectDelete` events. */
  objectType?: string;
  objectId?: string;
  /** Current state of the object after upsert; undefined on delete. */
  object?: unknown;
  /** For `streamEvent` events. */
  streamType?: string;
  streamId?: string;
  streamEvent?: unknown;
}

export interface FrickProjectionContext {
  tenantId: string;
  store: FrickStore;
  logger: FrickLogger;
}

export interface ProjectionChange {
  /** Projection-defined row key, e.g. `${userId}:${conversationId}`. */
  key: string;
  /** `null` means delete; non-null replaces the current row value. */
  value: PlainObject | null;
}

export interface ProjectionApplyResult {
  changes: ProjectionChange[];
}

export interface ProjectionDeltaNotice {
  projection: string;
  tenantId: string;
  changes: ProjectionChange[];
}

export interface FrickProjectionHandler {
  /**
   * Called synchronously after each matching source write succeeds. Must be
   * idempotent — the framework may replay events during rebuild.
   *
   * May optionally return `{ changes }` to declare which projection rows
   * were affected by this event. The registry forwards declared changes to
   * the optional `onDelta` hook so the sync gateway can broadcast a
   * `ProjectionDelta` frame to subscribed clients. Handlers that don't
   * return anything (legacy shape) simply emit no deltas.
   */
  apply(
    event: FrickProjectionWriteEvent,
    ctx: FrickProjectionContext,
  ): void | ProjectionApplyResult;
  /**
   * Optional: rebuild the projection's state from source data for the given
   * tenant. Called by the admin `/_frick/admin/projections/:name/rebuild`
   * route.
   */
  rebuild?(ctx: FrickProjectionContext): void;
  /**
   * Optional: serve `GET /projections/:name?<query>`. Projections that omit
   * this method receive 405 from the framework.
   */
  read?(ctx: FrickProjectionContext, query: Record<string, string>): unknown;
}

export interface FrickProjection {
  /** Stable identifier, e.g. `activity-feed`. */
  name: string;
  /** Source writes that trigger `apply(...)`. */
  sources: readonly FrickProjectionSource[];
  handler: FrickProjectionHandler;
}

export interface FrickProjectionRegistry {
  register(projection: FrickProjection): void;
  list(): readonly FrickProjection[];
  get(name: string): FrickProjection | undefined;
  /**
   * Dispatch a write event to every registered projection whose `sources`
   * match its kind+type. Projections fire in registration order.
   */
  notify(event: FrickProjectionWriteEvent, ctx: FrickProjectionContext): void;
  /**
   * Invoke `rebuild(...)` on every registered projection that implements it.
   * Returns the names of projections that were actually rebuilt (skipping
   * those without a `rebuild` method).
   */
  rebuildAll(ctx: FrickProjectionContext): { rebuilt: string[] };
  /**
   * Install a delta listener. The registry forwards every
   * {@link ProjectionDeltaNotice} produced by a handler's `apply(...)` return
   * value to this callback. Passing `undefined` clears the listener. Only one
   * listener is supported in v1; this is intentionally narrow — the sync
   * gateway is the only intended consumer.
   */
  setDeltaListener(listener: ((notice: ProjectionDeltaNotice) => void) | undefined): void;
  /**
   * Return the current materialized rows for `name` scoped to `tenantId`, as
   * the list of changes that would reproduce them on a fresh client. Used by
   * the sync gateway to deliver an initial snapshot on subscribe. Rows are
   * tracked from the `changes` declared by the projection handler's
   * `apply(...)`, so this only reflects state the handler has chosen to
   * publish — a projection that never returns changes has an empty snapshot.
   * Returns an empty array for an unknown projection or a tenant with no rows.
   */
  snapshot(name: string, tenantId: string): ProjectionChange[];
}

export interface CreateFrickProjectionRegistryOptions {
  /** Optional initial delta listener; equivalent to calling `setDeltaListener`. */
  onDelta?: (notice: ProjectionDeltaNotice) => void;
}

export function createFrickProjectionRegistry(
  options: CreateFrickProjectionRegistryOptions = {},
): FrickProjectionRegistry {
  const projections: FrickProjection[] = [];
  const byName = new Map<string, FrickProjection>();
  let deltaListener: ((notice: ProjectionDeltaNotice) => void) | undefined = options.onDelta;
  // Materialized snapshot state: projection name -> tenant id -> (row key ->
  // row value). Populated from the `changes` a handler returns from
  // `apply(...)`, so the gateway can replay current rows to a fresh
  // subscriber. Tenant-scoped so a snapshot never leaks cross-tenant rows.
  const rowsByProjection = new Map<string, Map<string, Map<string, PlainObject>>>();

  function applyChangesToSnapshot(projection: string, tenantId: string, changes: ProjectionChange[]): void {
    let byTenant = rowsByProjection.get(projection);
    if (!byTenant) {
      byTenant = new Map();
      rowsByProjection.set(projection, byTenant);
    }
    let rows = byTenant.get(tenantId);
    if (!rows) {
      rows = new Map();
      byTenant.set(tenantId, rows);
    }
    for (const change of changes) {
      if (change.value === null) {
        rows.delete(change.key);
      } else {
        rows.set(change.key, change.value);
      }
    }
    if (rows.size === 0) {
      byTenant.delete(tenantId);
      if (byTenant.size === 0) {
        rowsByProjection.delete(projection);
      }
    }
  }

  function register(projection: FrickProjection): void {
    if (byName.has(projection.name)) {
      throw new Error(`Projection "${projection.name}" is already registered`);
    }
    byName.set(projection.name, projection);
    projections.push(projection);
  }

  function matches(source: FrickProjectionSource, event: FrickProjectionWriteEvent): boolean {
    if (source.kind === "object") {
      if (event.kind !== "objectUpsert" && event.kind !== "objectDelete") return false;
      return source.type === event.objectType;
    }
    if (event.kind !== "streamEvent") return false;
    return source.type === event.streamType;
  }

  function notify(event: FrickProjectionWriteEvent, ctx: FrickProjectionContext): void {
    for (const projection of projections) {
      if (projection.sources.some((source) => matches(source, event))) {
        try {
          const result = projection.handler.apply(event, ctx);
          if (result && result.changes.length > 0) {
            // Materialize the row change into the tenant-scoped snapshot
            // state regardless of whether a listener is attached, so a
            // client that subscribes later still gets a complete snapshot.
            applyChangesToSnapshot(projection.name, ctx.tenantId, result.changes);
          }
          if (result && result.changes.length > 0 && deltaListener) {
            try {
              deltaListener({
                projection: projection.name,
                tenantId: ctx.tenantId,
                changes: result.changes,
              });
            } catch (error) {
              // The listener (sync gateway) should never break a write path.
              ctx.logger.warn("frick.projection.delta_listener_failed", {
                projection: projection.name,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        } catch (error) {
          // Never let a projection failure tear down the originating write.
          ctx.logger.warn("frick.projection.apply_failed", {
            projection: projection.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  function rebuildAll(ctx: FrickProjectionContext): { rebuilt: string[] } {
    const rebuilt: string[] = [];
    for (const projection of projections) {
      if (projection.handler.rebuild) {
        projection.handler.rebuild(ctx);
        rebuilt.push(projection.name);
      }
    }
    return { rebuilt };
  }

  return {
    register,
    list: () => projections.slice(),
    get: (name) => byName.get(name),
    notify,
    rebuildAll,
    setDeltaListener(listener) {
      deltaListener = listener;
    },
    snapshot(name, tenantId) {
      const rows = rowsByProjection.get(name)?.get(tenantId);
      if (!rows) {
        return [];
      }
      return [...rows.entries()].map(([key, value]) => ({ key, value }));
    },
  };
}
