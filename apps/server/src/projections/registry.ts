import type { FrickLogger } from "../logger.js";
import type { FrickStore } from "../store.js";

/**
 * A registered "projection" derives an app-readable view from one or more
 * source write streams (object upserts/deletes, stream appends). The
 * conversation inbox is the canonical example: it watches `MessageStream`
 * events and `RoomMember` upserts to maintain a per-user inbox row.
 *
 * Projections in this slice are HTTP-read-only: a registered projection
 * exposes an optional `read(ctx, query)` method that the framework wires up
 * at `GET /projections/:name`. Real-time delta push over the sync gateway is
 * deliberately deferred — see the projections design note in
 * `docs/operations.md`.
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

export interface FrickProjectionHandler {
  /**
   * Called synchronously after each matching source write succeeds. Must be
   * idempotent — the framework may replay events during rebuild.
   */
  apply(event: FrickProjectionWriteEvent, ctx: FrickProjectionContext): void;
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
  /** Stable identifier, e.g. `conversation-inbox`. */
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
}

export function createFrickProjectionRegistry(): FrickProjectionRegistry {
  const projections: FrickProjection[] = [];
  const byName = new Map<string, FrickProjection>();

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
          projection.handler.apply(event, ctx);
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
  };
}
