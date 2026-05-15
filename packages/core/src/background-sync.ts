/**
 * Web background sync registration helper.
 *
 * Pairs with `apps/web/public/frick-sw.js`: registers the Service
 * Worker, asks for a `sync` event on the `frick-pending-appends` tag,
 * and listens for the `frick:flush` message the worker posts back when
 * the browser fires that sync. The page-side handler the consumer
 * supplies is typically `client.flushPendingAppends()` or equivalent.
 *
 * Graceful degradation: callers should branch on the return value;
 * `ok: false` means the runtime doesn't support what's needed (Safari
 * has no Background Sync API, for instance) and the caller can fall
 * back to draining on visibilitychange / focus.
 */

export interface FrickBackgroundSyncOptions {
  /**
   * Where to find the worker. Defaults to `/frick-sw.js`. The framework
   * ships the worker under `apps/web/public/` so this default works for
   * Vite-served apps without further config.
   */
  readonly scriptUrl?: string;
  /**
   * Handler the runtime calls when the worker says "drain your queue."
   * Typically `() => client.flushPendingAppends()`.
   */
  readonly onFlush: () => void | Promise<void>;
  /**
   * Optional handler for the worker's deep-link routing posts.
   */
  readonly onNavigate?: (url: string) => void;
}

export interface FrickBackgroundSyncRegistration {
  /** Manually trigger a background-sync drain. */
  readonly requestSync: () => Promise<void>;
  /** Unregister the worker + message listeners. */
  readonly unregister: () => Promise<void>;
}

export async function registerFrickBackgroundSync(
  options: FrickBackgroundSyncOptions,
): Promise<
  | { ok: true; registration: FrickBackgroundSyncRegistration }
  | { ok: false; reason: string }
> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return { ok: false, reason: "no-service-worker" };
  }
  const scriptUrl = options.scriptUrl ?? "/frick-sw.js";
  const registration = await navigator.serviceWorker.register(scriptUrl);
  const messageHandler = (event: MessageEvent): void => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "frick:flush") {
      void options.onFlush();
    } else if (data.type === "frick:navigate" && typeof data.url === "string") {
      const url = normalizeNavigateUrl(data.url);
      if (url !== undefined) {
        options.onNavigate?.(url);
      }
    }
  };
  navigator.serviceWorker.addEventListener("message", messageHandler);

  const requestSync = async (): Promise<void> => {
    // SyncManager is browser-only and not in lib.dom for all targets;
    // probe by name to avoid a hard dependency on the SyncManager type.
    const sync = (registration as unknown as { sync?: { register(tag: string): Promise<void> } }).sync;
    if (sync) {
      try {
        await sync.register("frick-pending-appends");
        return;
      } catch {
        // fall through to manual drain
      }
    }
    // Fallback: invoke the handler directly so the caller still drains.
    await options.onFlush();
  };

  return {
    ok: true,
    registration: {
      requestSync,
      unregister: async () => {
        navigator.serviceWorker.removeEventListener("message", messageHandler);
        await registration.unregister();
      },
    },
  };
}

function normalizeNavigateUrl(value: string): string | undefined {
  const baseOrigin =
    typeof globalThis.location?.origin === "string"
      ? globalThis.location.origin
      : "http://localhost";
  let parsed: URL;
  try {
    parsed = new URL(value, `${baseOrigin}/`);
  } catch {
    return undefined;
  }
  if (parsed.origin !== baseOrigin) {
    return undefined;
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
