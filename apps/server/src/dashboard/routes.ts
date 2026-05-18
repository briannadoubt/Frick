import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "../authz.js";
import type { FrickAppRegistry } from "../apps/registry.js";
import type { PlatformEventPipeline } from "../platform-events/types.js";
import type { FrickProjectModule } from "../platform/project.js";
import type { FrickStore } from "../store.js";
import {
  buildAnalyticsSummary,
  normalizeAnalyticsSummaryWindowMs,
  type AnalyticsEventStore,
} from "../analytics/summary.js";
import { buildDashboardAccounts } from "./accounts.js";
import { buildDashboardObjectData } from "./data.js";
import { buildDashboardMetadata } from "./metadata.js";
import { buildDashboardTenants } from "./tenants.js";
import { sendDashboardAsset } from "./assets.js";

export interface DashboardRouteInput {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly project: FrickProjectModule;
  readonly appRegistry: FrickAppRegistry;
  readonly store: FrickStore;
  readonly platformEvents: PlatformEventPipeline;
  readonly analyticsEvents: AnalyticsEventStore;
  readonly authenticate: () => Principal | Error;
  readonly sendJson: (status: number, body: unknown) => void;
  readonly sendError: (error: unknown, requestId: string) => void;
}

const dashboardPrefix = "/_frick/dashboard";

const securityHeaders: Record<string, string> = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "script-src-attr 'none'",
    "style-src 'self'",
    "style-src-attr 'none'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

export async function handleDashboardRoute(input: DashboardRouteInput): Promise<boolean> {
  if (!isDashboardPath(input.url.pathname)) return false;

  if (input.request.method !== "GET" && input.request.method !== "HEAD") {
    input.response.writeHead(405, {
      ...securityHeaders,
      allow: "GET, HEAD",
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    input.response.end("method not allowed");
    return true;
  }

  const relativePath = input.url.pathname.slice(dashboardPrefix.length);
  if (relativePath === "") {
    input.response.writeHead(302, {
      ...securityHeaders,
      location: "/_frick/dashboard/",
      "cache-control": "no-store",
    });
    input.response.end();
    return true;
  }

  if (relativePath === "/api/metadata") {
    setDashboardHeaders(input.response);
    const principal = input.authenticate();
    if (principal instanceof Error) {
      input.sendError(principal, "dashboard_unauthorized");
      return true;
    }

    sendDashboardJson(input, 200, buildDashboardMetadata({
      project: input.project,
      appRegistry: input.appRegistry,
      platformEventsHealth: await input.platformEvents.health(),
    }));
    return true;
  }

  if (relativePath === "/api/analytics/summary") {
    setDashboardHeaders(input.response);
    const principal = input.authenticate();
    if (principal instanceof Error) {
      input.sendError(principal, "dashboard_unauthorized");
      return true;
    }

    sendDashboardJson(input, 200, buildAnalyticsSummary({
      store: input.analyticsEvents,
      principal,
      windowMs: normalizeAnalyticsSummaryWindowMs(input.url.searchParams.get("windowMs")),
      ...optionalLimit(input.url.searchParams.get("limit")),
    }));
    return true;
  }

  if (relativePath === "/api/accounts") {
    setDashboardHeaders(input.response);
    const principal = input.authenticate();
    if (principal instanceof Error) {
      input.sendError(principal, "dashboard_unauthorized");
      return true;
    }

    const tenantId = input.url.searchParams.get("tenantId") || undefined;
    sendDashboardJson(input, 200, buildDashboardAccounts({
      store: input.store,
      principal,
      ...(tenantId ? { tenantId } : {}),
      ...optionalLimit(input.url.searchParams.get("limit")),
    }));
    return true;
  }

  if (relativePath === "/api/tenants") {
    setDashboardHeaders(input.response);
    const principal = input.authenticate();
    if (principal instanceof Error) {
      input.sendError(principal, "dashboard_unauthorized");
      return true;
    }

    sendDashboardJson(input, 200, buildDashboardTenants({
      store: input.store,
      principal,
      includeArchived: input.url.searchParams.get("includeArchived") === "true",
      ...optionalLimit(input.url.searchParams.get("limit")),
    }));
    return true;
  }

  const objectDataType = parseObjectDataPath(relativePath);
  if (objectDataType !== undefined) {
    setDashboardHeaders(input.response);
    const principal = input.authenticate();
    if (principal instanceof Error) {
      input.sendError(principal, "dashboard_unauthorized");
      return true;
    }

    const tenantId = input.url.searchParams.get("tenantId") || undefined;
    const data = buildDashboardObjectData({
      store: input.store,
      principal,
      type: objectDataType,
      ...(tenantId ? { tenantId } : {}),
      ...optionalLimit(input.url.searchParams.get("limit")),
    });
    if (!data) {
      sendDashboardJson(input, 404, { error: "unknown_object_type", type: objectDataType });
      return true;
    }

    sendDashboardJson(input, 200, data);
    return true;
  }

  if (relativePath === "/api/platform-events/health") {
    setDashboardHeaders(input.response);
    const principal = input.authenticate();
    if (principal instanceof Error) {
      input.sendError(principal, "dashboard_unauthorized");
      return true;
    }

    sendDashboardJson(input, 200, await input.platformEvents.health());
    return true;
  }

  const sent = await sendDashboardAsset({
    request: input.request,
    response: input.response,
    path: relativePath,
    headers: securityHeaders,
  });
  if (sent) return true;

  sendDashboardJson(input, 404, { error: "not_found" });
  return true;
}

function isDashboardPath(pathname: string): boolean {
  return pathname === dashboardPrefix || pathname.startsWith(`${dashboardPrefix}/`);
}

function optionalLimit(value: string | null): { limit?: number } {
  if (value === null || value === "") return {};
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return {};
  return { limit: parsed };
}

function parseObjectDataPath(relativePath: string): string | undefined {
  const prefix = "/api/data/objects/";
  if (!relativePath.startsWith(prefix)) return undefined;
  const encodedType = relativePath.slice(prefix.length);
  if (!encodedType || encodedType.includes("/")) return "";
  try {
    return decodeURIComponent(encodedType);
  } catch {
    return "";
  }
}

function setDashboardHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(securityHeaders)) {
    response.setHeader(name, value);
  }
  response.setHeader("cache-control", "no-store");
}

function sendDashboardJson(
  input: DashboardRouteInput,
  status: number,
  body: unknown,
): void {
  setDashboardHeaders(input.response);
  if (input.request.method === "HEAD") {
    input.response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
    });
    input.response.end();
    return;
  }
  input.sendJson(status, body);
}
