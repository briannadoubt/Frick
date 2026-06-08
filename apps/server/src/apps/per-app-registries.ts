/**
 * Per-app registry sets (FR-38, FR-6 epic).
 *
 * Today the server builds ONE projection registry and ONE job-handler
 * registry and shares them across every app a multi-app server hosts (see
 * `apps/registry.ts`: "projections, processors ... remain server-shared").
 * That means app A's projection for `Conversation` fires on app B's
 * `Conversation` writes, and a job handler app A registered runs app B's jobs
 * of the same type — a cross-app execution leak.
 *
 * This module de-shares those registries: a {@link FrickPerAppRegistries}
 * container holds one independent {@link FrickAppRegistrySet} per `appId`
 * (projection registry + job registry), created lazily on first access. The
 * default deployment uses a single `'_default'` app, so a single-app server
 * still has exactly one set and behaves identically — the per-app split only
 * materializes when distinct app ids are used.
 *
 * The container is additive: it composes the existing
 * {@link createFrickProjectionRegistry} / {@link createFrickJobRegistry}
 * factories rather than reimplementing them, so each per-app set is a full,
 * already-tested registry. Callers route to the right set with `.for(appId)`,
 * mirroring how `tenantId` scopes the store facades.
 */
import { DEFAULT_APP_ID } from "../app-id.js";
import {
  createFrickJobRegistry,
  type FrickJobRegistry,
} from "../jobs/registry.js";
import {
  createFrickProjectionRegistry,
  type CreateFrickProjectionRegistryOptions,
  type FrickProjectionRegistry,
  type ProjectionDeltaNotice,
} from "../projections/registry.js";

/** The independent set of de-shared registries owned by a single app. */
export interface FrickAppRegistrySet {
  /** The app id this set belongs to. */
  readonly appId: string;
  /** Projection registry scoped to this app — app A's projections never see app B's writes. */
  readonly projections: FrickProjectionRegistry;
  /** Job-handler registry scoped to this app — a handler registered for app A never runs app B's jobs. */
  readonly jobs: FrickJobRegistry;
}

export interface FrickPerAppRegistries {
  /**
   * Return the registry set for `appId`, creating it on first access.
   * Omitting `appId` (or passing the default) returns the `'_default'` app's
   * set, which is the only set a single-app server ever touches.
   */
  for(appId?: string): FrickAppRegistrySet;
  /** True when a set has already been created for `appId`. */
  has(appId: string): boolean;
  /** App ids that currently have a registry set, in creation order. */
  appIds(): string[];
}

export interface CreateFrickPerAppRegistriesOptions {
  /**
   * Factory invoked once per app the first time its projection registry is
   * created. Lets the caller install a per-app delta listener (the sync
   * gateway needs one per app so a `ProjectionDelta` is routed back to the
   * subscribers of the *originating* app, never another app's clients).
   * Receives the app id so the listener can tag/route by app.
   */
  readonly projectionDeltaListenerFor?: (
    appId: string,
  ) => ((notice: ProjectionDeltaNotice) => void) | undefined;
}

/**
 * Build a per-app registry container. Each app's set is created lazily and
 * cached, so apps that never receive traffic cost nothing. The `'_default'`
 * set is created eagerly so the common single-app path has a set ready without
 * a first-access branch.
 */
export function createFrickPerAppRegistries(
  options: CreateFrickPerAppRegistriesOptions = {},
): FrickPerAppRegistries {
  const sets = new Map<string, FrickAppRegistrySet>();

  function createSet(appId: string): FrickAppRegistrySet {
    const projectionOptions: CreateFrickProjectionRegistryOptions = {};
    const listener = options.projectionDeltaListenerFor?.(appId);
    if (listener) {
      projectionOptions.onDelta = listener;
    }
    const set: FrickAppRegistrySet = {
      appId,
      projections: createFrickProjectionRegistry(projectionOptions),
      jobs: createFrickJobRegistry(),
    };
    sets.set(appId, set);
    return set;
  }

  // Eagerly create the default app's set.
  createSet(DEFAULT_APP_ID);

  return {
    for(appId = DEFAULT_APP_ID) {
      const id = appId === "" ? DEFAULT_APP_ID : appId;
      return sets.get(id) ?? createSet(id);
    },
    has(appId) {
      return sets.has(appId);
    },
    appIds() {
      return [...sets.keys()];
    },
  };
}
