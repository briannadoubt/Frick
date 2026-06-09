/**
 * App-scoped store facade (tenant-app-isolation-2).
 *
 * A per-app background-job handler runs against the one shared {@link FrickStore},
 * but its store writes must land in the originating app's partition, not the
 * `_default` app. The worker stamps `FrickJobContext.appId` from the job row and
 * hands the handler `store.forApp(job.appId)` as `ctx.store`. That view is the
 * object built here: a thin {@link Proxy} over the real store that defaults the
 * `appId` argument on the write facades a handler reaches for —
 * `upsertObject`, `appendEvent`, `setPresence`, `clearPresence`,
 * `enqueueSignal`, and `jobs.enqueue` — while delegating every other property
 * and method (reads, `blobs`, `schema`, the rest of `jobs`, …) straight through
 * to the underlying store, unchanged.
 *
 * The injection is "default, don't override": a handler that passes an explicit
 * `appId` still wins. This keeps the facade a pure ergonomics+safety layer with
 * no behavioural change for callers that were already app-aware, and the store's
 * `forApp(_default)` short-circuits to the store itself so single-app servers
 * never touch this path.
 */
import { DEFAULT_APP_ID } from "./app-id.js";
import type { FrickStore } from "./store.js";

/** Build the app-scoped Proxy view of `store` pinned to `appId`. */
export function createAppScopedStore(store: FrickStore, appId: string): FrickStore {
  // A jobs facade whose `enqueue(input)` defaults `appId` when the structured
  // form omits it. The legacy 3-arg `enqueue(tenantId, jobType, value)` form
  // has no app axis, so it stays `_default` (matching its tenant default) — a
  // per-app handler that wants app scoping uses the structured form, which is
  // the only form that carries `appId` at all.
  const jobs = store.jobs;
  const scopedJobs = new Proxy(jobs, {
    get(target, prop, receiver) {
      if (prop === "enqueue") {
        const enqueue = target.enqueue.bind(target) as (...args: unknown[]) => unknown;
        return (a: unknown, b?: unknown, c?: unknown) => {
          if (a !== null && typeof a === "object") {
            const input = a as { appId?: string };
            return enqueue({ appId, ...input });
          }
          // Legacy positional form — no app axis; forward verbatim.
          return enqueue(a, b, c);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return new Proxy(store, {
    get(target, prop, receiver) {
      switch (prop) {
        case "forApp":
          // Re-scoping is idempotent: `ctx.store.forApp(x)` resolves against the
          // real store so a handler can still reach another app explicitly.
          return (nextAppId: string | undefined) => target.forApp(nextAppId);
        case "jobs":
          return scopedJobs;
        case "upsertObject":
          // Legacy positional overloads:
          //   (type, id, value, version?)                      → _default tenant
          //   (tenantId, type, id, value, version?, appId?)    → tenant-aware
          // We only inject `appId` on the tenant-aware (6-arg) shape, identified
          // by `arguments[2]` (the id) being a string. The 4-arg form targets
          // the default tenant and is left untouched.
          return (...args: unknown[]) => {
            if (typeof args[2] === "string" || args[2] === undefined) {
              // tenant-aware form; default the trailing appId when omitted.
              const next = args.slice(0, 6);
              while (next.length < 6) next.push(undefined);
              if (next[5] === undefined) next[5] = appId;
              return (target.upsertObject as (...a: unknown[]) => Promise<void>)(...next);
            }
            return (target.upsertObject as (...a: unknown[]) => Promise<void>)(...args);
          };
        case "appendEvent":
          return (input: { appId?: string }) =>
            target.appendEvent({ appId, ...input } as Parameters<typeof target.appendEvent>[0]);
        case "setPresence":
          // (tenantId, type, key, value, ttlMs, appId?) is the 6-arg tenant form
          // (ttlMs at index 4 is a number). The 4-arg legacy form targets the
          // default tenant and carries no app axis.
          return (...args: unknown[]) => {
            if (typeof args[4] === "number") {
              const next = args.slice(0, 6);
              while (next.length < 6) next.push(undefined);
              if (next[5] === undefined) next[5] = appId;
              return (target.setPresence as (...a: unknown[]) => Promise<void>)(...next);
            }
            return (target.setPresence as (...a: unknown[]) => Promise<void>)(...args);
          };
        case "clearPresence":
          // (tenantId, type, key, appId?) tenant form vs (type, key) legacy form.
          return (...args: unknown[]) => {
            if (typeof args[2] === "string" || (args.length >= 3 && args[2] === undefined)) {
              const next = args.slice(0, 4);
              while (next.length < 4) next.push(undefined);
              if (next[3] === undefined) next[3] = appId;
              return (target.clearPresence as (...a: unknown[]) => Promise<void>)(...next);
            }
            return (target.clearPresence as (...a: unknown[]) => Promise<void>)(...args);
          };
        case "enqueueSignal":
          // (tenantId, type, key, value, ttlMs?, appId?) tenant form: index 3 is
          // the value object. The legacy (type, key, value, ttlMs?) form has the
          // value object at index 2.
          return (...args: unknown[]) => {
            if (args[3] !== null && typeof args[3] === "object") {
              const next = args.slice(0, 6);
              while (next.length < 6) next.push(undefined);
              if (next[5] === undefined) next[5] = appId;
              return (target.enqueueSignal as (...a: unknown[]) => Promise<void>)(...next);
            }
            return (target.enqueueSignal as (...a: unknown[]) => Promise<void>)(...args);
          };
        default: {
          const value = Reflect.get(target, prop, receiver);
          // Bind plain methods to the real store so `this` and private (`#`)
          // field access resolve against the genuine instance, not the Proxy.
          return typeof value === "function" ? value.bind(target) : value;
        }
      }
    },
  });
}

export { DEFAULT_APP_ID };
