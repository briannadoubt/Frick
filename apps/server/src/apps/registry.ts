import type { FrickSchema } from "@fricken/protocol";
import { FrickConfigError } from "../config.js";
import type { FrickProjection } from "../projections/registry.js";
import type { FrickJobHandler } from "../jobs/registry.js";

/**
 * Declarative description of a Frick "app" — a distinct schema mounted at a
 * URL prefix on the multi-app server. Storage is server-shared but partitioned
 * by `app_id` (FR-153); URL routing selects the active app at the request
 * boundary.
 *
 * Per-app projections and job handlers (FR-153): an app MAY declare its own
 * `projections` / `jobs` so its projection registry and job-handler registry
 * are independent of every other app's — app A's projection never fires on app
 * B's writes, and a handler app A registered never runs app B's jobs. When an
 * app omits them, that app simply has no app-local projections/handlers (the
 * server-wide `options.projections` / `options.jobs.handlers` still apply to
 * the default app). Single-app servers declare neither and are unaffected.
 */
export interface FrickAppDefinition {
  /** Stable identifier, e.g. "chat" or "docs". Surfaced in errors and inspection. */
  readonly id: string;
  /** The app's schema. Returned from `GET <basePath>/schema` and used for Hello compatibility checks. */
  readonly schema: FrickSchema;
  /**
   * URL prefix the app is mounted under. Must start with "/", no trailing slash.
   * The root app uses "" (empty string) to preserve the legacy single-app layout.
   */
  readonly basePath: string;
  /**
   * Projections scoped to THIS app (FR-153). Registered into the app's own
   * projection registry, so they only observe writes made under this app's id.
   */
  readonly projections?: readonly FrickProjection[];
  /**
   * Background-job handlers scoped to THIS app (FR-153), keyed by job type.
   * Registered into the app's own job-handler registry, so they only run jobs
   * enqueued under this app's id.
   */
  readonly jobs?: Readonly<Record<string, FrickJobHandler>>;
}

/** Result of a successful path lookup against the registry. */
export interface FrickAppResolution {
  readonly app: FrickAppDefinition;
  /** The request URL with the matched basePath stripped (still starts with "/"). */
  readonly relativePath: string;
}

export interface FrickAppRegistry {
  /** List apps in registration order. */
  list(): FrickAppDefinition[];
  /** Find an app by id. */
  get(id: string): FrickAppDefinition | undefined;
  /** Find an app whose schemaId matches (used by hello-driven WS routing). */
  findBySchemaId(schemaId: string): FrickAppDefinition | undefined;
  /** Pick the app whose basePath is the longest prefix of `url.pathname`. */
  resolveByPath(url: URL): FrickAppResolution | undefined;
}

/**
 * Build an app registry from a list of definitions. Validates that every
 * basePath is unique, starts with "/", and has no trailing slash. The empty
 * basePath ("") is permitted exactly once and represents the root app.
 */
export function createFrickAppRegistry(
  apps: readonly FrickAppDefinition[],
): FrickAppRegistry {
  const seenBasePaths = new Set<string>();
  const seenIds = new Set<string>();
  for (const app of apps) {
    if (app.basePath !== "" && (!app.basePath.startsWith("/") || app.basePath.endsWith("/"))) {
      throw new FrickConfigError(
        `App "${app.id}" basePath must start with "/" and have no trailing slash (got ${JSON.stringify(app.basePath)})`,
      );
    }
    if (seenBasePaths.has(app.basePath)) {
      throw new FrickConfigError(
        `Duplicate Frick app basePath ${JSON.stringify(app.basePath)} (app id "${app.id}")`,
      );
    }
    if (seenIds.has(app.id)) {
      throw new FrickConfigError(`Duplicate Frick app id "${app.id}"`);
    }
    seenBasePaths.add(app.basePath);
    seenIds.add(app.id);
  }

  // Sort longest-first so resolveByPath returns the most specific match.
  const sorted = [...apps].sort((a, b) => b.basePath.length - a.basePath.length);
  const ordered = [...apps];

  return {
    list() {
      return [...ordered];
    },
    get(id) {
      return ordered.find((app) => app.id === id);
    },
    findBySchemaId(schemaId) {
      return ordered.find((app) => app.schema.schemaId === schemaId);
    },
    resolveByPath(url) {
      const pathname = url.pathname;
      for (const app of sorted) {
        if (app.basePath === "") {
          // Root app matches anything; loop continues sorted by length so
          // this is only reached when no longer prefix matched.
          return { app, relativePath: pathname };
        }
        if (pathname === app.basePath) {
          return { app, relativePath: "/" };
        }
        if (pathname.startsWith(`${app.basePath}/`)) {
          return { app, relativePath: pathname.slice(app.basePath.length) };
        }
      }
      return undefined;
    },
  };
}
