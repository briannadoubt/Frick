import type { FrickErrorEnvelope, PlainObject } from "@fricken/protocol";
import {
  defaultClientTelemetryRuntime,
  finishClientTelemetrySpan,
  injectClientTelemetryHeaders,
  recordClientTelemetryCounter,
  recordClientTelemetryHistogram,
  startClientTelemetrySpan,
  type FrickClientTelemetryRuntime,
} from "./telemetry.js";

export type AnalyticsAttributes = Record<string, string | number | boolean>;
type FetchImpl = (input: URL, init?: RequestInit) => Promise<Response>;

export interface AnalyticsTrackOptions {
  properties?: PlainObject;
  context?: PlainObject;
  attributes?: AnalyticsAttributes;
  traceId?: string;
  idempotencyKey?: string;
  occurredAt?: string | Date;
}

export interface TrackAnalyticsEventInput extends AnalyticsTrackOptions {
  httpEndpoint: string;
  sessionToken?: string | undefined;
  name: string;
  fetchImpl?: FetchImpl | undefined;
  telemetry?: FrickClientTelemetryRuntime | undefined;
}

export interface AnalyticsTrackReceipt {
  ok: true;
  eventId: string;
  sequence: number;
  acceptedAt: string;
  duplicate: boolean;
}

export interface AnalyticsTrackingClient {
  track(
    name: string,
    properties?: PlainObject,
    options?: Omit<AnalyticsTrackOptions, "properties">,
  ): Promise<AnalyticsTrackReceipt>;
}

export interface BrowserAnalyticsWindow {
  location: {
    href: string;
    pathname: string;
    search: string;
    hash: string;
  };
  document?: {
    title?: string;
  };
  history?: {
    pushState?: (...args: [unknown, string, string | URL | null | undefined]) => unknown;
    replaceState?: (...args: [unknown, string, string | URL | null | undefined]) => unknown;
  };
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

export interface BrowserAnalyticsTrackingOptions {
  window?: BrowserAnalyticsWindow;
  trackInitialRoute?: boolean;
  trackHistoryChanges?: boolean;
  screenName?: (location: BrowserAnalyticsWindow["location"]) => string | undefined;
  routeProperties?: (location: BrowserAnalyticsWindow["location"]) => PlainObject;
  onError?: (error: unknown) => void;
}

export interface BrowserAnalyticsTracker {
  trackCurrentRoute(): Promise<AnalyticsTrackReceipt | undefined>;
  flush(): Promise<void>;
  dispose(): void;
}

export async function trackAnalyticsEvent({
  httpEndpoint,
  sessionToken,
  name,
  properties,
  context,
  attributes,
  traceId,
  idempotencyKey,
  occurredAt,
  fetchImpl = fetch,
  telemetry = defaultClientTelemetryRuntime(),
}: TrackAnalyticsEventInput): Promise<AnalyticsTrackReceipt> {
  const startedAtMs = Date.now();
  const span = startClientTelemetrySpan(telemetry, {
    name: "frick.analytics.track",
    kind: "client",
    attributes: {
      "frick.analytics.event_name": name,
      "url.path": "/analytics/events",
    },
  });
  const headers = authorizedJsonHeaders(sessionToken);
  injectClientTelemetryHeaders(span, headers);
  let finished = false;
  const finish = (result: {
    status: "ok" | "error";
    metricStatus: string;
    httpStatusCode?: number;
    duplicate?: boolean;
    error?: unknown;
  }): void => {
    if (finished) return;
    finished = true;
    const durationMs = Date.now() - startedAtMs;
    const attributes: AnalyticsAttributes = {
      "frick.analytics.status": result.metricStatus,
      ...(result.httpStatusCode !== undefined ? { "http.response.status_code": result.httpStatusCode } : {}),
      ...(result.duplicate !== undefined ? { "frick.analytics.duplicate": result.duplicate } : {}),
    };
    finishClientTelemetrySpan(span, {
      status: result.status,
      attributes,
      ...(result.error !== undefined ? { error: result.error } : {}),
    });
    recordClientTelemetryCounter(telemetry, "frick.client.analytics.events.total", 1, {
      status: result.metricStatus,
    });
    recordClientTelemetryHistogram(telemetry, "frick.client.analytics.duration_ms", durationMs, {
      status: result.metricStatus,
    });
  };

  let response: Response;
  try {
    response = await fetchImpl(frickHttpUrl(httpEndpoint, "analytics/events"), {
      method: "POST",
      headers,
      body: JSON.stringify(
        withoutUndefined({
          name,
          properties,
          context,
          attributes,
          traceId: traceId ?? span.traceId,
          idempotencyKey,
          occurredAt: occurredAt instanceof Date ? occurredAt.toISOString() : occurredAt,
        }),
      ),
    });
  } catch (error) {
    finish({
      status: "error",
      metricStatus: "network_error",
      error,
    });
    throw error;
  }

  if (!response.ok) {
    const message = await analyticsErrorMessage(response);
    finish({
      status: "error",
      metricStatus: "rejected",
      httpStatusCode: response.status,
      error: new Error(message),
    });
    throw new Error(message);
  }

  try {
    const receipt = (await response.json()) as AnalyticsTrackReceipt;
    finish({
      status: "ok",
      metricStatus: receipt.duplicate ? "duplicate" : "accepted",
      httpStatusCode: response.status,
      duplicate: receipt.duplicate,
    });
    return receipt;
  } catch (error) {
    finish({
      status: "error",
      metricStatus: "rejected",
      httpStatusCode: response.status,
      error,
    });
    throw error;
  }
}

export function installBrowserAnalyticsTracking(
  client: AnalyticsTrackingClient,
  options: BrowserAnalyticsTrackingOptions = {},
): BrowserAnalyticsTracker {
  const browser = options.window ?? browserWindow();
  if (!browser) {
    return noopBrowserAnalyticsTracker();
  }
  const trackInitialRoute = options.trackInitialRoute ?? true;
  const trackHistoryChanges = options.trackHistoryChanges ?? true;
  const routeProperties = options.routeProperties ?? ((location) => defaultRouteProperties(browser, location));
  const screenName = options.screenName ?? (() => "screen.viewed");
  const onError = options.onError ?? (() => undefined);
  const pending = new Set<Promise<void>>();
  let disposed = false;
  let lastRouteKey: string | undefined;

  const enqueue = (promise: Promise<unknown>): void => {
    const wrapped = promise.then(
      () => undefined,
      (error) => {
        onError(error);
      },
    );
    pending.add(wrapped);
    void wrapped.finally(() => pending.delete(wrapped));
  };

  const trackCurrentRoute = async (): Promise<AnalyticsTrackReceipt | undefined> => {
    if (disposed) return undefined;
    const routeKey = `${browser.location.pathname}${browser.location.search}${browser.location.hash}`;
    if (routeKey === lastRouteKey) return undefined;
    lastRouteKey = routeKey;
    const name = screenName(browser.location);
    if (!name) return undefined;
    return client.track(name, routeProperties(browser.location));
  };

  const scheduleRouteTrack = (): void => {
    enqueue(trackCurrentRoute());
  };

  const detachHistoryTracking =
    trackHistoryChanges && browser.history
      ? attachHistoryTracking(browser, scheduleRouteTrack)
      : undefined;

  if (trackInitialRoute) {
    scheduleRouteTrack();
  }

  return {
    trackCurrentRoute,
    async flush() {
      await Promise.allSettled(Array.from(pending));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      detachHistoryTracking?.();
    },
  };
}

function frickHttpUrl(httpEndpoint: string, path: string): URL {
  const baseUrl = `${httpEndpoint.replace(/\/$/, "")}/`;
  return new URL(path.replace(/^\/+/, ""), baseUrl);
}

function browserWindow(): BrowserAnalyticsWindow | undefined {
  const candidate = (globalThis as { window?: BrowserAnalyticsWindow }).window;
  return candidate?.location ? candidate : undefined;
}

function noopBrowserAnalyticsTracker(): BrowserAnalyticsTracker {
  return {
    async trackCurrentRoute() {
      return undefined;
    },
    async flush() {
      return undefined;
    },
    dispose() {
      return undefined;
    },
  };
}

function defaultRouteProperties(
  browser: BrowserAnalyticsWindow,
  location: BrowserAnalyticsWindow["location"],
): PlainObject {
  const title = browser.document?.title ?? "";
  return {
    path: location.pathname,
    title,
  };
}

interface HistoryPatchState {
  browser: BrowserAnalyticsWindow;
  originalPushState?: NonNullable<NonNullable<BrowserAnalyticsWindow["history"]>["pushState"]>;
  originalReplaceState?: NonNullable<NonNullable<BrowserAnalyticsWindow["history"]>["replaceState"]>;
  patchedPushState?: NonNullable<NonNullable<BrowserAnalyticsWindow["history"]>["pushState"]>;
  patchedReplaceState?: NonNullable<NonNullable<BrowserAnalyticsWindow["history"]>["replaceState"]>;
  listeners: Set<() => void>;
  popstateListener: () => void;
}

const historyPatches = new WeakMap<BrowserAnalyticsWindow, HistoryPatchState>();

function attachHistoryTracking(browser: BrowserAnalyticsWindow, listener: () => void): () => void {
  let state = historyPatches.get(browser);
  if (!state) {
    state = createHistoryPatch(browser);
    historyPatches.set(browser, state);
  }
  state.listeners.add(listener);
  return () => {
    const current = historyPatches.get(browser);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size > 0) return;
    restoreHistoryPatch(current);
    historyPatches.delete(browser);
  };
}

function createHistoryPatch(browser: BrowserAnalyticsWindow): HistoryPatchState {
  const history = browser.history!;
  const state: HistoryPatchState = {
    browser,
    listeners: new Set(),
    popstateListener: () => notifyHistoryListeners(state),
  };
  if (history.pushState) {
    state.originalPushState = history.pushState;
  }
  if (history.replaceState) {
    state.originalReplaceState = history.replaceState;
  }
  if (state.originalPushState) {
    state.patchedPushState = (...args) => {
      const result = state.originalPushState!.apply(history, args);
      notifyHistoryListeners(state);
      return result;
    };
    history.pushState = state.patchedPushState;
  }
  if (state.originalReplaceState) {
    state.patchedReplaceState = (...args) => {
      const result = state.originalReplaceState!.apply(history, args);
      notifyHistoryListeners(state);
      return result;
    };
    history.replaceState = state.patchedReplaceState;
  }
  browser.addEventListener?.("popstate", state.popstateListener);
  return state;
}

function notifyHistoryListeners(state: HistoryPatchState): void {
  for (const listener of state.listeners) {
    listener();
  }
}

function restoreHistoryPatch(state: HistoryPatchState): void {
  const history = state.browser.history;
  if (history) {
    if (state.originalPushState && history.pushState === state.patchedPushState) {
      history.pushState = state.originalPushState;
    }
    if (state.originalReplaceState && history.replaceState === state.patchedReplaceState) {
      history.replaceState = state.originalReplaceState;
    }
  }
  state.browser.removeEventListener?.("popstate", state.popstateListener);
}

function authorizedJsonHeaders(sessionToken: string | undefined): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
  };
}

async function analyticsErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as FrickHttpErrorBody | unknown;
    if (body && typeof body === "object") {
      const error = "error" in body ? body.error : undefined;
      if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
        return error.message;
      }
      if ("message" in body && typeof body.message === "string") {
        return body.message;
      }
    }
  } catch {
    // Fall back to the status line when the server did not return JSON.
  }
  return `Analytics request returned ${response.status}`;
}

interface FrickHttpErrorBody {
  error?: FrickErrorEnvelope;
  message?: string;
}

function withoutUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}
