const DEFAULT_ENDPOINT = isMountedDashboard() ? location.origin : "http://127.0.0.1:4099";
const DASHBOARD_PORT = "4299";
const STORAGE_KEYS = {
  endpoint: "fricken-dashboard:endpoint",
  token: "fricken-dashboard:token",
  route: "fricken-dashboard:route",
  objectType: "fricken-dashboard:objectType",
  tenantId: "fricken-dashboard:tenantId",
  blobOwnerId: "fricken-dashboard:blobOwnerId",
  jobType: "fricken-dashboard:jobType",
  jobStatus: "fricken-dashboard:jobStatus",
};

const app = document.getElementById("app");

const navItems = [
  { id: "overview", label: "Overview", icon: "dashboard" },
  { id: "realtime", label: "Realtime", icon: "pulse" },
  { id: "data", label: "Data", icon: "database" },
  { id: "auth", label: "Auth", icon: "lock" },
  { id: "storage", label: "Storage", icon: "box" },
  { id: "jobs", label: "Jobs", icon: "queue" },
  { id: "observability", label: "Observability", icon: "chart" },
  { id: "settings", label: "Settings", icon: "settings" },
];

const launchTargets = [
  { label: "Web demo", description: "Open the Frick browser demo.", path: "http://127.0.0.1:5173", icon: "window" },
  { label: "Tilt", description: "Open the local Tilt resource graph.", path: "http://localhost:10350", icon: "layers" },
  { label: "Schema", description: "Inspect the active foundation schema JSON.", path: "/schema", icon: "schema" },
  { label: "Health", description: "Check process liveness without auth.", path: "/health", icon: "heart" },
  { label: "Ready", description: "Check database and migration readiness.", path: "/ready", icon: "check" },
  { label: "DevTools events", description: "Read the inspection event feed.", path: "/_frick/inspect/devtools/events", icon: "activity" },
];

const initialEndpoint = new URLSearchParams(location.search).get("endpoint");
if (initialEndpoint) localStorage.setItem(STORAGE_KEYS.endpoint, initialEndpoint);

const state = {
  route: normalizeRoute(location.hash.slice(1) || localStorage.getItem(STORAGE_KEYS.route) || "overview"),
  endpoint:
    initialEndpoint ||
    (isMountedDashboard()
      ? DEFAULT_ENDPOINT
      : localStorage.getItem(STORAGE_KEYS.endpoint) || DEFAULT_ENDPOINT),
  token: localStorage.getItem(STORAGE_KEYS.token) || "",
  devUserId: "user-ada",
  eventFilter: "",
  selectedEventId: undefined,
  selectedObjectType: localStorage.getItem(STORAGE_KEYS.objectType) || "",
  dataTenantId: localStorage.getItem(STORAGE_KEYS.tenantId) || "",
  blobOwnerId: localStorage.getItem(STORAGE_KEYS.blobOwnerId) || "",
  jobType: localStorage.getItem(STORAGE_KEYS.jobType) || "",
  jobStatus: localStorage.getItem(STORAGE_KEYS.jobStatus) || "",
  loading: false,
  lastRefresh: undefined,
  data: {},
  errors: {},
};

function normalizeRoute(route) {
  return navItems.some((item) => item.id === route) ? route : "overview";
}

function isMountedDashboard() {
  return location.pathname === "/_frick/dashboard" || location.pathname.startsWith("/_frick/dashboard/");
}

function endpointUrl(path) {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  const base = new URL(state.endpoint);
  if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`;
  base.search = "";
  base.hash = "";
  return new URL(path, base).toString();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function icon(name) {
  const common = 'class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const paths = {
    activity: '<path d="M22 12h-4l-3 8L9 4l-3 8H2" />',
    box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" />',
    chart: '<path d="M3 3v18h18" /><path d="M7 15v2" /><path d="M12 9v8" /><path d="M17 5v12" />',
    check: '<path d="m20 6-11 11-5-5" />',
    clipboard: '<path d="M9 5h6" /><path d="M9 3h6a2 2 0 0 1 2 2v1h1a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h1V5a2 2 0 0 1 2-2Z" />',
    dashboard: '<rect x="3" y="3" width="7" height="8" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="15" width="7" height="6" rx="1" />',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />',
    heart: '<path d="M20.8 4.6a5.4 5.4 0 0 0-7.6 0L12 5.8l-1.2-1.2a5.4 5.4 0 1 0-7.6 7.6L12 21l8.8-8.8a5.4 5.4 0 0 0 0-7.6Z" />',
    layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" />',
    link: '<path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1" />',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />',
    pulse: '<path d="M4 12h4l2-7 4 14 2-7h4" />',
    queue: '<path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" />',
    refresh: '<path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" />',
    schema: '<path d="M12 3v4" /><path d="M7 7h10v6H7Z" /><path d="M12 13v4" /><path d="M5 21h14" /><path d="M8 17h8v4H8Z" />',
    settings: '<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 1 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1A2 2 0 1 1 7.1 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.1a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1Z" />',
    window: '<rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /><path d="M8 4v5" />',
  };
  return `<svg ${common}>${paths[name] || paths.dashboard}</svg>`;
}

function statusTone(ok, skipped) {
  if (skipped) return "warn";
  return ok ? "good" : "bad";
}

function toneClass(tone) {
  return `tone-${tone || "info"}`;
}

function dot(tone) {
  return `<span class="status-dot dot-${tone || "info"}"></span>`;
}

function formatAge(iso) {
  if (!iso) return "Never";
  const elapsed = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(elapsed)) return "Unknown";
  if (elapsed < 1000) return "just now";
  if (elapsed < 60000) return `${Math.round(elapsed / 1000)}s ago`;
  if (elapsed < 3600000) return `${Math.round(elapsed / 60000)}m ago`;
  return new Date(iso).toLocaleString();
}

function shortHash(hash) {
  if (!hash) return "unknown";
  return String(hash).length > 12 ? `${String(hash).slice(0, 12)}...` : String(hash);
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatBytes(value) {
  const bytes = numberValue(value);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function metricEntries(kind) {
  const metrics = state.data.metrics;
  return Array.isArray(metrics?.[kind]) ? metrics[kind] : [];
}

function sumCounters(name) {
  return metricEntries("counters")
    .filter((entry) => entry.name === name)
    .reduce((sum, entry) => sum + numberValue(entry.value), 0);
}

function gaugeValue(name) {
  const entry = metricEntries("gauges").find((candidate) => candidate.name === name);
  return numberValue(entry?.value, 0);
}

function platformEventsHealth() {
  return state.data.platformEvents || state.data.dashboardMetadata?.platformEvents;
}

function analyticsSummary() {
  return state.data.analyticsSummary;
}

function analyticsUnavailableDetail() {
  const error = state.errors.analyticsSummary;
  if (error?.skipped) return "Add a bearer token to load product analytics.";
  if (error) return error.message;
  return "Analytics inspection route required.";
}

function platformEventsUnavailableDetail() {
  const error = state.errors.platformEvents;
  if (error?.skipped) return "Add a bearer token to load pipeline health.";
  if (error) return error.message;
  return "Platform event inspection route required.";
}

function dashboardObjectResources(metadata = state.data.dashboardMetadata) {
  return (metadata?.resources || []).filter((resource) => resource.kind === "object");
}

function selectedDashboardObjectType(metadata = state.data.dashboardMetadata) {
  const resources = dashboardObjectResources(metadata);
  if (!resources.length) return "";
  if (
    state.selectedObjectType &&
    resources.some((resource) => resource.name === state.selectedObjectType)
  ) {
    return state.selectedObjectType;
  }
  if (
    state.data.dashboardObjectData?.type &&
    resources.some((resource) => resource.name === state.data.dashboardObjectData.type)
  ) {
    return state.data.dashboardObjectData.type;
  }
  return resources[0].name;
}

function selectedDashboardTenantId(tenants = state.data.dashboardTenants) {
  const rows = tenants?.tenants || [];
  if (
    state.dataTenantId &&
    (!rows.length || rows.some((tenant) => tenant.tenantId === state.dataTenantId))
  ) {
    return state.dataTenantId;
  }
  return rows[0]?.tenantId || state.dataTenantId || "";
}

function requestRows() {
  const rows = metricEntries("counters").filter((entry) => entry.name === "frick.http.requests.total");
  const grouped = new Map();
  for (const row of rows) {
    const status = row.fields?.status || "unknown";
    grouped.set(status, (grouped.get(status) || 0) + numberValue(row.value));
  }
  return Array.from(grouped.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

function frameRows() {
  const rows = metricEntries("counters").filter((entry) => entry.name === "frick.ws.frames.total");
  return rows
    .map((row) => ({ label: row.fields?.kind || "unknown", value: numberValue(row.value) }))
    .sort((a, b) => b.value - a.value);
}

function analyticsTopEventRows() {
  return (analyticsSummary()?.topEvents || []).map((row) => ({
    label: row.name,
    value: numberValue(row.count),
  }));
}

function analyticsTopRouteRows() {
  return (analyticsSummary()?.topRoutes || []).map((row) => ({
    label: row.path,
    value: numberValue(row.count),
  }));
}

async function fetchJson(path, options = {}) {
  if (options.auth && !state.token) {
    const error = new Error("Session token required");
    error.skipped = true;
    throw error;
  }

  const headers = { accept: "application/json" };
  if (options.auth) headers.authorization = `Bearer ${state.token}`;
  const response = await fetch(endpointUrl(path), { headers });
  const text = await response.text();
  let body = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }

  if (!response.ok) {
    const message = body?.error?.message || body?.message || body?.error || response.statusText;
    const error = new Error(`${response.status} ${message}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function refreshData() {
  state.loading = true;
  render();

  const tasks = {
    health: () => fetchJson("/health"),
    ready: () => fetchJson("/ready"),
    server: () => fetchJson("/_frick/inspect/server", { auth: true }),
    apps: () => fetchJson("/_frick/inspect/apps", { auth: true }),
    db: () => fetchJson("/_frick/inspect/db", { auth: true }),
    migrations: () => fetchJson("/_frick/inspect/migrations", { auth: true }),
    metrics: () => fetchJson("/_frick/inspect/metrics", { auth: true }),
    jobs: () => fetchJson("/_frick/inspect/jobs", { auth: true }),
    projections: () => fetchJson("/_frick/inspect/projections", { auth: true }),
    search: () => fetchJson("/_frick/inspect/search", { auth: true }),
    dashboardMetadata: () => fetchDashboardMetadata(),
    analyticsSummary: () => fetchAnalyticsSummary(),
    platformEvents: () => fetchPlatformEventsHealth(),
    eventSummary: () => fetchJson("/_frick/inspect/devtools/summary?windowMs=300000", { auth: true }),
    events: () =>
      fetchJson(
        `/_frick/inspect/devtools/events?limit=50${state.eventFilter ? `&kind=${encodeURIComponent(state.eventFilter)}` : ""}`,
        { auth: true },
      ),
  };

  const nextData = {};
  const nextErrors = {};
  await Promise.all(
    Object.entries(tasks).map(async ([key, task]) => {
      try {
        const value = await task();
        if (
          (key === "dashboardMetadata" || key === "analyticsSummary" || key === "platformEvents") &&
          value === undefined
        ) return;
        nextData[key] = value;
      } catch (error) {
        nextErrors[key] = error;
      }
    }),
  );

  if (isMountedDashboard()) {
    try {
      nextData.dashboardTenants = await fetchDashboardTenants();
    } catch (error) {
      nextErrors.dashboardTenants = error;
    }

    try {
      nextData.dashboardTenantSettings = await fetchDashboardTenantSettings(
        selectedDashboardTenantId(nextData.dashboardTenants),
      );
    } catch (error) {
      nextErrors.dashboardTenantSettings = error;
    }

    try {
      nextData.dashboardAccounts = await fetchDashboardAccounts();
    } catch (error) {
      nextErrors.dashboardAccounts = error;
    }

    try {
      nextData.dashboardBlobs = await fetchDashboardBlobs(
        selectedDashboardTenantId(nextData.dashboardTenants),
      );
    } catch (error) {
      nextErrors.dashboardBlobs = error;
    }

    try {
      nextData.dashboardJobs = await fetchDashboardJobs(
        selectedDashboardTenantId(nextData.dashboardTenants),
      );
    } catch (error) {
      nextErrors.dashboardJobs = error;
    }

    const objectType = selectedDashboardObjectType(nextData.dashboardMetadata);
    if (objectType) {
      try {
        nextData.dashboardObjectData = await fetchDashboardObjectData(objectType);
      } catch (error) {
        nextErrors.dashboardObjectData = error;
      }
    }
  }

  state.data = nextData;
  state.errors = nextErrors;
  state.lastRefresh = new Date().toISOString();
  state.loading = false;
  render();
}

async function fetchDashboardMetadata() {
  if (!isMountedDashboard()) return undefined;
  return fetchJson("/_frick/dashboard/api/metadata", { auth: true });
}

async function fetchAnalyticsSummary() {
  const path = isMountedDashboard()
    ? "/_frick/dashboard/api/analytics/summary?windowMs=86400000"
    : "/_frick/inspect/analytics/summary?windowMs=86400000";
  return fetchJson(path, { auth: true });
}

async function fetchPlatformEventsHealth() {
  const path = isMountedDashboard()
    ? "/_frick/dashboard/api/platform-events/health"
    : "/_frick/inspect/platform-events";
  return fetchJson(path, { auth: true });
}

async function fetchDashboardObjectData(type) {
  if (!isMountedDashboard() || !type) return undefined;
  const params = new URLSearchParams({ limit: "25" });
  if (state.dataTenantId) params.set("tenantId", state.dataTenantId);
  return fetchJson(`/_frick/dashboard/api/data/objects/${encodeURIComponent(type)}?${params}`, {
    auth: true,
  });
}

async function fetchDashboardAccounts() {
  if (!isMountedDashboard()) return undefined;
  const params = new URLSearchParams({ limit: "25" });
  if (state.dataTenantId) params.set("tenantId", state.dataTenantId);
  return fetchJson(`/_frick/dashboard/api/accounts?${params}`, { auth: true });
}

async function fetchDashboardTenants() {
  if (!isMountedDashboard()) return undefined;
  const params = new URLSearchParams({ includeArchived: "true", limit: "50" });
  return fetchJson(`/_frick/dashboard/api/tenants?${params}`, { auth: true });
}

async function fetchDashboardTenantSettings(tenantId) {
  if (!isMountedDashboard()) return undefined;
  const params = new URLSearchParams();
  if (tenantId) params.set("tenantId", tenantId);
  return fetchJson(`/_frick/dashboard/api/tenant-settings?${params}`, { auth: true });
}

async function fetchDashboardBlobs(tenantId) {
  if (!isMountedDashboard()) return undefined;
  const params = new URLSearchParams({ limit: "25" });
  if (tenantId) params.set("tenantId", tenantId);
  if (state.blobOwnerId) params.set("ownerId", state.blobOwnerId);
  return fetchJson(`/_frick/dashboard/api/blobs?${params}`, { auth: true });
}

async function fetchDashboardJobs(tenantId) {
  if (!isMountedDashboard()) return undefined;
  const params = new URLSearchParams({ limit: "25" });
  if (tenantId) params.set("tenantId", tenantId);
  if (state.jobStatus) params.set("status", state.jobStatus);
  if (state.jobType) params.set("jobType", state.jobType);
  return fetchJson(`/_frick/dashboard/api/jobs?${params}`, { auth: true });
}

async function devLogin() {
  const response = await fetch(endpointUrl("/auth/dev-login"), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ userId: state.devUserId || "user-ada" }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || body?.message || response.statusText);
  }
  const token = body.sessionToken || body.token;
  if (!token) throw new Error("Dev login response did not include a session token");
  state.token = token;
  localStorage.setItem(STORAGE_KEYS.token, token);
  await refreshData();
}

function routeTitle() {
  return navItems.find((item) => item.id === state.route)?.label || "Overview";
}

function connectionStatus() {
  const healthOk = state.data.health?.ok === true;
  const readyOk = state.data.ready?.status === "ready";
  const hasToken = Boolean(state.token);
  const inspectOk = Boolean(state.data.server);
  const serverError = state.errors.health || state.errors.ready;
  return { healthOk, readyOk, hasToken, inspectOk, serverError };
}

function statusStrip() {
  const status = connectionStatus();
  const healthTone = state.errors.health ? "bad" : status.healthOk ? "good" : "warn";
  const readyTone = state.errors.ready ? "bad" : status.readyOk ? "good" : "warn";
  const inspectSkipped = state.errors.server?.skipped;
  const inspectTone = statusTone(status.inspectOk, inspectSkipped);
  return `
    <div class="status-strip">
      <span class="status-pill ${toneClass(healthTone)}">${dot(healthTone)} Health ${escapeHtml(status.healthOk ? "ok" : state.errors.health ? "offline" : "unknown")}</span>
      <span class="status-pill ${toneClass(readyTone)}">${dot(readyTone)} Ready ${escapeHtml(status.readyOk ? "ready" : state.errors.ready ? "not ready" : "unknown")}</span>
      <span class="status-pill ${toneClass(inspectTone)}">${dot(inspectTone)} Inspection ${escapeHtml(status.inspectOk ? "connected" : inspectSkipped ? "needs token" : "unavailable")}</span>
      <span class="status-pill tone-info">${dot("info")} Endpoint ${escapeHtml(state.endpoint)}</span>
      <span class="refresh-note">${state.loading ? "Refreshing..." : `Last refresh: ${escapeHtml(formatAge(state.lastRefresh))}`}</span>
    </div>
  `;
}

function metricCard(label, value, detail, tone = "info") {
  return `
    <article class="metric-card">
      <header>
        <span>${escapeHtml(label)}</span>
        <span class="status-tag ${toneClass(tone)}">${dot(tone)} ${escapeHtml(tone)}</span>
      </header>
      <div class="metric-value">${escapeHtml(value)}</div>
      <p>${escapeHtml(detail)}</p>
    </article>
  `;
}

function overviewMetrics() {
  const server = state.data.server;
  const db = state.data.db;
  const eventSummary = state.data.eventSummary;
  const analytics = analyticsSummary();
  const platformEvents = platformEventsHealth();
  const wsConnections = gaugeValue("frick.ws.connections.current");
  const requests = sumCounters("frick.http.requests.total");
  const frames = sumCounters("frick.ws.frames.total");
  const cache = db?.idempotencyCache;
  return `
    <section class="metric-grid" aria-label="Overview metrics">
      ${metricCard(
        "Server",
        state.data.ready?.status || (state.errors.health ? "offline" : "unknown"),
        server ? `${server.env} env, app ${server.appId || "foundation"}` : "Start pnpm server or connect with a token.",
        state.data.ready?.status === "ready" ? "good" : state.errors.health ? "bad" : "warn",
      )}
      ${metricCard(
        "Schema",
        server?.schemaRevision ? `rev ${server.schemaRevision}` : "not loaded",
        `hash ${shortHash(server?.schemaHash || state.data.ready?.schemaHash)}`,
        server ? "good" : "warn",
      )}
      ${metricCard("WebSockets", wsConnections, `${frames} frame events counted`, wsConnections > 0 ? "good" : "info")}
      ${metricCard("HTTP requests", requests, "In-process counter snapshot", requests > 0 ? "good" : "info")}
      ${metricCard(
        "DevTools events",
        eventSummary?.total ?? 0,
        "Events in the last five minutes",
        eventSummary?.total ? "good" : state.token ? "info" : "warn",
      )}
      ${metricCard(
        "Analytics events",
        analytics?.totals?.events ?? 0,
        analytics
          ? `${analytics.totals.uniqueUsers} users, ${analytics.topEvents.length} event types`
          : analyticsUnavailableDetail(),
        analytics?.totals?.events ? "good" : analytics ? "info" : "warn",
      )}
      ${metricCard(
        "Platform events",
        platformEvents ? platformEvents.adapter : "not loaded",
        platformEvents
          ? `${platformEvents.pending} pending, ${platformEvents.deadLettered} dead-lettered`
          : platformEventsUnavailableDetail(),
        platformEvents?.ok ? "good" : platformEvents ? "bad" : "warn",
      )}
      ${metricCard(
        "Idempotency cache",
        cache ? `${cache.size}/${cache.capacity}` : "not loaded",
        cache ? `${cache.evictions} evictions since boot` : "Requires inspection access.",
        cache ? "good" : "warn",
      )}
    </section>
  `;
}

function barChart(title, rows, empty, color = "green") {
  const max = Math.max(1, ...rows.map((row) => row.value));
  const body = rows.length
    ? rows
        .slice(0, 8)
        .map((row) => {
          const width = Math.max(5, Math.round((row.value / max) * 20) * 5);
          return `
            <div class="bar-row">
              <span class="table-label">${escapeHtml(row.label)}</span>
              <span class="bar-track"><span class="bar-fill ${escapeHtml(color)} w-${width}"></span></span>
              <strong class="nowrap">${escapeHtml(row.value)}</strong>
            </div>
          `;
        })
        .join("")
    : `<div class="empty-state">${escapeHtml(empty)}</div>`;
  return `
    <section class="panel">
      <header class="panel-header">
        <div>
          <span class="panel-kicker">Metrics</span>
          <h2 class="panel-title">${escapeHtml(title)}</h2>
        </div>
      </header>
      <div class="panel-body chart">${body}</div>
    </section>
  `;
}

function eventRows(limit = 8) {
  const events = state.data.events?.events || [];
  if (!events.length) {
    const message = state.errors.events?.skipped
      ? "Add a session token or run Dev Login to read the event feed."
      : "No devtools events returned yet.";
    return `<div class="empty-state">${escapeHtml(message)}</div>`;
  }
  return `
    <div class="event-list">
      ${events
        .slice(0, limit)
        .map((event) => {
          const selected = event.id === state.selectedEventId;
          return `
            <button class="event-row" type="button" data-event-id="${escapeHtml(event.id)}" data-selected="${selected}">
              <span>
                <span class="event-kind">${escapeHtml(event.kind)}</span>
                <span class="event-meta">${escapeHtml(event.tenantId || "server")} · ${escapeHtml(formatAge(event.occurredAt))}</span>
              </span>
              <span class="status-tag tone-info">#${escapeHtml(event.id)}</span>
            </button>
          `;
        })
        .join("")}
    </div>
  `;
}

function activityPanel(limit = 8) {
  return `
    <section class="panel">
      <header class="panel-header">
        <div>
          <span class="panel-kicker">Live feed</span>
          <h2 class="panel-title">Recent DevTools events</h2>
        </div>
        <button class="icon-button" type="button" data-action="refresh" title="Refresh">${icon("refresh")}</button>
      </header>
      <div class="panel-body">${eventRows(limit)}</div>
    </section>
  `;
}

function analyticsPanel() {
  const analytics = analyticsSummary();
  return `
    <div class="split-panel">
      ${barChart(
        "Product events",
        analyticsTopEventRows(),
        analytics ? "No product analytics events in this window." : analyticsUnavailableDetail(),
        "green",
      )}
      ${barChart(
        "Viewed routes",
        analyticsTopRouteRows(),
        analytics ? "No route views in this window." : analyticsUnavailableDetail(),
        "blue",
      )}
    </div>
  `;
}

function launchGrid() {
  return `
    <section class="panel">
      <header class="panel-header">
        <div>
          <span class="panel-kicker">Local tools</span>
          <h2 class="panel-title">Launch targets</h2>
        </div>
      </header>
      <div class="panel-body">
        <div class="launch-grid">
          ${launchTargets
            .map((target) => `
              <a class="launch-tile" href="${escapeHtml(endpointUrl(target.path))}" target="_blank" rel="noopener">
                <header>
                  <span class="tile-icon">${icon(target.icon)}</span>
                  ${icon("link")}
                </header>
                <strong>${escapeHtml(target.label)}</strong>
                <p>${escapeHtml(target.description)}</p>
              </a>
            `)
            .join("")}
        </div>
      </div>
    </section>
  `;
}

function keyValueList(rows) {
  return `
    <div class="key-value-list">
      ${rows
        .map(([label, value]) => `
          <div class="key-value-row">
            <span class="field-label">${escapeHtml(label)}</span>
            <code>${escapeHtml(value ?? "unknown")}</code>
          </div>
        `)
        .join("")}
    </div>
  `;
}

function serverInspector() {
  const server = state.data.server;
  const ready = state.data.ready;
  const selectedEvent = (state.data.events?.events || []).find((event) => event.id === state.selectedEventId);
  return `
    <aside class="side-stack" aria-label="Dashboard inspector">
      <section class="detail-card">
        <header class="detail-header">
          <div>
            <span class="panel-kicker">Server</span>
            <h2 class="panel-title">Runtime identity</h2>
          </div>
        </header>
        <div class="detail-body">
          ${keyValueList([
            ["App", server?.appId || "foundation"],
            ["Environment", server?.env || "unknown"],
            ["Schema ID", server?.schemaId || ready?.schemaId],
            ["Schema revision", server?.schemaRevision || ready?.schemaRevision],
            ["Schema hash", server?.schemaHash || ready?.schemaHash],
            ["Started", server?.startedAt ? new Date(server.startedAt).toLocaleString() : "unknown"],
          ])}
        </div>
      </section>
      <section class="detail-card">
        <header class="detail-header">
          <div>
            <span class="panel-kicker">Selection</span>
            <h2 class="panel-title">${selectedEvent ? "Event payload" : "Inspection state"}</h2>
          </div>
        </header>
        <div class="detail-body">
          <pre>${escapeHtml(JSON.stringify(selectedEvent || inspectionSummary(), null, 2))}</pre>
        </div>
      </section>
    </aside>
  `;
}

function inspectionSummary() {
  const platformEvents = platformEventsHealth();
  const analytics = analyticsSummary();
  const summary = {
    endpoint: state.endpoint,
    hasToken: Boolean(state.token),
    server: state.data.server || null,
    db: state.data.db || null,
    jobs: state.data.jobs || null,
    platformEvents: platformEvents
      ? {
          adapter: platformEvents.adapter,
          ok: platformEvents.ok,
          pending: platformEvents.pending,
          deadLettered: platformEvents.deadLettered,
          consumers: platformEvents.consumers?.length ?? 0,
        }
      : null,
    analytics: analytics
      ? {
          events: analytics.totals?.events ?? 0,
          uniqueUsers: analytics.totals?.uniqueUsers ?? 0,
          topEvents: analytics.topEvents?.length ?? 0,
        }
      : null,
    errors: Object.fromEntries(
      Object.entries(state.errors)
        .filter(([, error]) => Boolean(error))
        .map(([key, error]) => [key, error.message]),
    ),
  };
  if (state.data.dashboardMetadata) {
    summary.project = state.data.dashboardMetadata.project;
    summary.resources = state.data.dashboardMetadata.resources?.length ?? 0;
  }
  return summary;
}

function renderOverview() {
  return `
    ${pageHeader(
      "Overview",
      "Fricken Dashboard turns the local Frick server into a Firebase-style console for schema, sync, data, jobs, and runtime inspection.",
    )}
    ${statusStrip()}
    <div class="dashboard-grid">
      <div class="primary-stack">
        ${overviewMetrics()}
        <div class="split-panel">
          ${barChart("HTTP requests by status", requestRows(), "No request counters yet. Refresh after exercising the server.", "green")}
          ${activityPanel(6)}
        </div>
        ${launchGrid()}
      </div>
      ${serverInspector()}
    </div>
  `;
}

function renderRealtime() {
  const summary = state.data.eventSummary;
  return `
    ${pageHeader("Realtime", "Watch WebSocket connection pressure, frame counters, and sync-related DevTools events.")}
    ${statusStrip()}
    <div class="dashboard-grid">
      <div class="primary-stack">
        <section class="metric-grid">
          ${metricCard("Current sockets", gaugeValue("frick.ws.connections.current"), "Live WebSocket gauge", gaugeValue("frick.ws.connections.current") > 0 ? "good" : "info")}
          ${metricCard("Frame count", sumCounters("frick.ws.frames.total"), "All frame kinds since process start", "info")}
          ${metricCard("Event window", summary?.total ?? 0, "DevTools events in five minutes", summary?.total ? "good" : "info")}
        </section>
        ${barChart("Frame counts by kind", frameRows(), "No WebSocket frames counted yet. Open the web demo and send a message.", "blue")}
        ${activityPanel(10)}
      </div>
      ${serverInspector()}
    </div>
  `;
}

function renderData() {
  const db = state.data.db;
  const migrations = state.data.migrations?.applied || [];
  const projections = state.data.projections?.projections || [];
  const search = state.data.search;
  return `
    ${pageHeader("Data", "Inspect schema-defined objects, persistence readiness, migrations, projections, search indexes, and cache pressure.")}
    ${statusStrip()}
    <div class="dashboard-grid">
      <div class="primary-stack">
        <section class="metric-grid">
          ${metricCard("Database", db?.ready ? "ready" : "unknown", `${db?.applied ?? 0} migrations applied`, db?.ready ? "good" : "warn")}
          ${metricCard("Migrations", migrations.length, migrations.at(-1)?.id || "No migration ledger loaded", migrations.length ? "good" : "warn")}
          ${metricCard("Search adapter", search?.adapter || "unknown", `${search?.indexes?.length ?? 0} indexes registered`, search ? "good" : "warn")}
        </section>
        ${dashboardObjectBrowser()}
        <section class="panel">
          <header class="panel-header">
            <div>
              <span class="panel-kicker">Migrations</span>
              <h2 class="panel-title">Applied ledger</h2>
            </div>
          </header>
          <div class="panel-body">${migrationTable(migrations)}</div>
        </section>
        <div class="split-panel">
          ${definitionListPanel("Projections", projections.map((item) => [item.name, `${item.supportsRead ? "read" : "no read"} / ${item.supportsRebuild ? "rebuild" : "no rebuild"}`]))}
          ${definitionListPanel("Search indexes", (search?.indexes || []).map((item) => [item.name, JSON.stringify(item.source)]))}
        </div>
      </div>
      ${serverInspector()}
    </div>
  `;
}

function dashboardObjectBrowser() {
  if (!isMountedDashboard()) {
    return `
      <section class="panel">
        <header class="panel-header">
          <div>
            <span class="panel-kicker">Objects</span>
            <h2 class="panel-title">Schema data</h2>
          </div>
        </header>
        <div class="panel-body">
          <div class="empty-state">Mount Fricken Dashboard at /_frick/dashboard to browse schema object rows from the server origin.</div>
        </div>
      </section>
    `;
  }

  const resources = dashboardObjectResources();
  const selected = selectedDashboardObjectType();
  const objectData = state.data.dashboardObjectData;
  const error = state.errors.dashboardObjectData;
  return `
    <section class="panel">
      <header class="panel-header">
        <div>
          <span class="panel-kicker">Objects</span>
          <h2 class="panel-title">Schema data</h2>
        </div>
        ${
          objectData
            ? `<span class="status-tag tone-info">${dot("info")} ${escapeHtml(objectData.scope)} / ${escapeHtml(objectData.tenantId)}</span>`
            : ""
        }
      </header>
      <div class="panel-body">
        ${
          resources.length
            ? `<div class="object-type-list">${resources
                .map((resource) => `
                  <button class="button ${resource.name === selected ? "primary" : "secondary"} object-type-button" type="button" data-object-type="${escapeHtml(resource.name)}">
                    ${icon("database")} ${escapeHtml(resource.name)}
                  </button>
                `)
                .join("")}</div>`
            : `<div class="empty-state">No schema object metadata loaded. Add a bearer token and refresh.</div>`
        }
        <form class="tenant-filter" data-form="object-tenant">
          <label class="form-row">
            <span class="field-label">Tenant</span>
            <span class="inline-fields">
              <input class="text-input" name="tenantId" value="${escapeHtml(state.dataTenantId)}" placeholder="_default" autocomplete="off" />
              <button class="button secondary" type="submit">${icon("check")} Apply</button>
            </span>
          </label>
        </form>
        ${error ? `<div class="error-box">${escapeHtml(error.message)}</div>` : ""}
        ${objectData ? objectDataSummary(objectData) : ""}
        ${objectDataTable(objectData)}
      </div>
    </section>
  `;
}

function objectDataSummary(data) {
  const detail = data.truncated
    ? `${data.count} of ${data.total} visible rows`
    : `${data.total} visible rows`;
  return `
    <div class="status-strip compact">
      <span class="status-pill tone-info">${dot("info")} ${escapeHtml(data.type)}</span>
      <span class="status-pill tone-info">${dot("info")} ${escapeHtml(detail)}</span>
      <span class="status-pill tone-info">${dot("info")} limit ${escapeHtml(data.limit)}</span>
    </div>
  `;
}

function objectDataTable(data) {
  if (!data) {
    if (state.errors.dashboardObjectData?.skipped) {
      return `<div class="empty-state">Add a bearer token to load schema object rows.</div>`;
    }
    return `<div class="empty-state">Choose a schema object to inspect rows.</div>`;
  }
  if (!data.rows.length) {
    return `<div class="empty-state">No visible rows for ${escapeHtml(data.type)}.</div>`;
  }

  const columns = objectTableColumns(data.rows);
  return `
    <div class="object-table-wrap">
      <table class="table">
        <thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead>
        <tbody>
          ${data.rows
            .map((row) => `
              <tr>
                ${columns
                  .map((column) => `<td>${formatObjectCell(row[column])}</td>`)
                  .join("")}
              </tr>
            `)
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function objectTableColumns(rows) {
  const columns = [];
  for (const preferred of ["id", "userId", "conversationId", "displayName", "title", "status"]) {
    if (rows.some((row) => Object.prototype.hasOwnProperty.call(row, preferred))) {
      columns.push(preferred);
    }
  }
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
      if (columns.length >= 6) return columns;
    }
  }
  return columns;
}

function formatObjectCell(value) {
  if (value === undefined) return `<span class="muted-cell">undefined</span>`;
  if (value === null) return `<span class="muted-cell">null</span>`;
  if (typeof value === "object") {
    return `<code class="code-inline json-cell">${escapeHtml(JSON.stringify(value))}</code>`;
  }
  return `<span>${escapeHtml(value)}</span>`;
}

function migrationTable(rows) {
  if (!rows.length) return `<div class="empty-state">No migration data loaded. Inspection may need a token.</div>`;
  return `
    <table class="table">
      <thead><tr><th>ID</th><th>Revision</th><th>Applied</th><th>Duration</th></tr></thead>
      <tbody>
        ${rows
          .slice()
          .reverse()
          .slice(0, 12)
          .map((row) => `
            <tr>
              <td><code class="code-inline">${escapeHtml(row.id)}</code></td>
              <td>${escapeHtml(row.schemaRevision)}</td>
              <td>${escapeHtml(new Date(row.appliedAt).toLocaleString())}</td>
              <td>${escapeHtml(row.durationMs ?? "n/a")}ms</td>
            </tr>
          `)
          .join("")}
      </tbody>
    </table>
  `;
}

function definitionListPanel(title, rows) {
  return `
    <section class="panel">
      <header class="panel-header">
        <div>
          <span class="panel-kicker">Registry</span>
          <h2 class="panel-title">${escapeHtml(title)}</h2>
        </div>
      </header>
      <div class="panel-body">
        ${
          rows.length
            ? `<div class="row-list">${rows
                .map(([label, detail]) => `
                  <div class="list-row">
                    <span><strong>${escapeHtml(label)}</strong><span class="row-meta">${escapeHtml(detail)}</span></span>
                    <span class="status-tag tone-info">${dot("info")} registered</span>
                  </div>
                `)
                .join("")}</div>`
            : `<div class="empty-state">Nothing reported by this endpoint yet.</div>`
        }
      </div>
    </section>
  `;
}

function renderAuth() {
  return `
    ${pageHeader("Auth", "Create a local dev session or paste an admin/session bearer to unlock inspection endpoints.")}
    ${statusStrip()}
    <div class="dashboard-grid">
      <div class="primary-stack">
        <section class="panel">
          <header class="panel-header">
            <div>
              <span class="panel-kicker">Development</span>
              <h2 class="panel-title">Dev login</h2>
            </div>
          </header>
          <div class="panel-body">
            ${state.errors.devLogin ? `<div class="error-box">${escapeHtml(state.errors.devLogin.message)}</div>` : ""}
            <form class="form-grid" data-form="dev-login">
              <label class="form-row">
                <span class="field-label">User ID</span>
                <span class="inline-fields">
                  <input class="text-input" name="devUserId" value="${escapeHtml(state.devUserId)}" autocomplete="off" />
                  <button class="button primary" type="submit">${icon("lock")} Dev Login</button>
                </span>
              </label>
              <p class="help-copy">The dashboard stores only the returned bearer in browser localStorage for this local console.</p>
            </form>
          </div>
        </section>
        <section class="panel">
          <header class="panel-header">
            <div>
              <span class="panel-kicker">Session</span>
              <h2 class="panel-title">Bearer token</h2>
            </div>
          </header>
          <div class="panel-body">
            <form class="form-grid" data-form="token">
              <label class="form-row">
                <span class="field-label">Token</span>
                <input class="text-input" name="token" value="${escapeHtml(state.token)}" autocomplete="off" />
              </label>
              <div class="topbar-actions">
                <button class="button primary" type="submit">${icon("check")} Save token</button>
                <button class="button secondary" type="button" data-action="clear-token">${icon("clipboard")} Clear</button>
              </div>
            </form>
          </div>
        </section>
        ${dashboardAccountsPanel()}
      </div>
      ${serverInspector()}
    </div>
  `;
}

function dashboardAccountsPanel() {
  if (!isMountedDashboard()) {
    return `
      <section class="panel">
        <header class="panel-header">
          <div>
            <span class="panel-kicker">Accounts</span>
            <h2 class="panel-title">Tenant accounts</h2>
          </div>
        </header>
        <div class="panel-body">
          <div class="empty-state">Mount Fricken Dashboard at /_frick/dashboard to browse account records from the server origin.</div>
        </div>
      </section>
    `;
  }

  const accounts = state.data.dashboardAccounts;
  const error = state.errors.dashboardAccounts;
  return `
    <section class="panel">
      <header class="panel-header">
        <div>
          <span class="panel-kicker">Accounts</span>
          <h2 class="panel-title">Tenant accounts</h2>
        </div>
        ${
          accounts
            ? `<span class="status-tag tone-info">${dot("info")} ${escapeHtml(accounts.scope)} / ${escapeHtml(accounts.tenantId)}</span>`
            : ""
        }
      </header>
      <div class="panel-body">
        <form class="tenant-filter" data-form="object-tenant">
          <label class="form-row">
            <span class="field-label">Tenant</span>
            <span class="inline-fields">
              <input class="text-input" name="tenantId" value="${escapeHtml(state.dataTenantId)}" placeholder="_default" autocomplete="off" />
              <button class="button secondary" type="submit">${icon("check")} Apply</button>
            </span>
          </label>
        </form>
        ${error ? `<div class="error-box">${escapeHtml(error.message)}</div>` : ""}
        ${accounts ? accountsSummary(accounts) : ""}
        ${accountsTable(accounts)}
      </div>
    </section>
  `;
}

function accountsSummary(data) {
  const detail = data.truncated
    ? `${data.count} visible accounts, more available`
    : `${data.count} visible accounts`;
  return `
    <div class="status-strip compact">
      <span class="status-pill tone-info">${dot("info")} ${escapeHtml(data.tenantId)}</span>
      <span class="status-pill tone-info">${dot("info")} ${escapeHtml(detail)}</span>
      <span class="status-pill tone-info">${dot("info")} limit ${escapeHtml(data.limit)}</span>
    </div>
  `;
}

function accountsTable(data) {
  if (!data) {
    if (state.errors.dashboardAccounts?.skipped) {
      return `<div class="empty-state">Add a bearer token to load tenant accounts.</div>`;
    }
    return `<div class="empty-state">No account data loaded yet.</div>`;
  }
  if (!data.accounts.length) {
    return `<div class="empty-state">No accounts visible for ${escapeHtml(data.tenantId)}.</div>`;
  }
  return `
    <div class="object-table-wrap">
      <table class="table">
        <thead><tr><th>Handle</th><th>User</th><th>Name</th><th>Created</th></tr></thead>
        <tbody>
          ${data.accounts
            .map((account) => `
              <tr>
                <td><code class="code-inline">${escapeHtml(account.handle)}</code></td>
                <td>${escapeHtml(account.userId)}</td>
                <td>${escapeHtml(account.displayName)}</td>
                <td>${escapeHtml(new Date(account.createdAt).toLocaleString())}</td>
              </tr>
            `)
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderStorage() {
  return `
    ${pageHeader("Storage", "Track the operational surfaces that guard durable data: blobs, backup routes, search, and tenant-scoped stores.")}
    ${statusStrip()}
    <div class="dashboard-grid">
      <div class="primary-stack">
        <section class="metric-grid">
          ${metricCard("Blob store", "SQLite", "Blob bytes are stored in SQLite in this cutover posture.", "info")}
          ${metricCard("Search", state.data.search?.adapter || "unknown", `${state.data.search?.indexes?.length ?? 0} indexes visible`, state.data.search ? "good" : "warn")}
          ${metricCard("Backup API", "admin", "Use /_frick/admin/backup and restore with admin auth.", "info")}
        </section>
        ${dashboardBlobBrowser()}
        ${launchGrid()}
        ${definitionListPanel("Storage routes", [
          ["/blobs", "Upload and derivative metadata paths"],
          ["/_frick/dashboard/api/blobs", "Read-only mounted dashboard blob metadata"],
          ["/search", "Tenant-visible search query route"],
          ["/_frick/admin/backup", "NDJSON backup stream"],
          ["/_frick/admin/restore", "NDJSON restore replay"],
        ])}
      </div>
      ${serverInspector()}
    </div>
  `;
}

function dashboardBlobBrowser() {
  if (!isMountedDashboard()) {
    return `
      <section class="panel">
        <header class="panel-header">
          <div>
            <span class="panel-kicker">Blobs</span>
            <h2 class="panel-title">Storage metadata</h2>
          </div>
        </header>
        <div class="panel-body">
          <div class="empty-state">Mount Fricken Dashboard at /_frick/dashboard to browse blob metadata from the server origin.</div>
        </div>
      </section>
    `;
  }

  const blobs = state.data.dashboardBlobs;
  const error = state.errors.dashboardBlobs;
  const selectedTenantId = selectedDashboardTenantId();
  return `
    <section class="panel">
      <header class="panel-header">
        <div>
          <span class="panel-kicker">Blobs</span>
          <h2 class="panel-title">Storage metadata</h2>
        </div>
        ${
          blobs
            ? `<span class="status-tag tone-info">${dot("info")} ${escapeHtml(blobs.scope)} / ${escapeHtml(blobs.tenantId)}</span>`
            : ""
        }
      </header>
      <div class="panel-body">
        <form class="tenant-filter" data-form="blob-filter">
          <label class="form-row">
            <span class="field-label">Tenant</span>
            <span class="inline-fields">
              <input class="text-input" name="tenantId" value="${escapeHtml(selectedTenantId)}" placeholder="_default" autocomplete="off" />
            </span>
          </label>
          <label class="form-row">
            <span class="field-label">Owner</span>
            <span class="inline-fields">
              <input class="text-input" name="ownerId" value="${escapeHtml(state.blobOwnerId)}" placeholder="user-ada" autocomplete="off" />
              <button class="button secondary" type="submit">${icon("check")} Apply</button>
            </span>
          </label>
        </form>
        ${error ? `<div class="error-box">${escapeHtml(error.message)}</div>` : ""}
        ${blobs ? blobSummary(blobs) : ""}
        ${blobTable(blobs)}
      </div>
    </section>
  `;
}

function blobSummary(data) {
  const detail = data.truncated
    ? `${data.count} of ${data.total} visible blobs`
    : `${data.total} visible blobs`;
  const totalBytes = data.blobs.reduce((sum, blob) => sum + numberValue(blob.byteLength), 0);
  const totalDerivatives = data.blobs.reduce(
    (sum, blob) => sum + numberValue(blob.derivatives?.count),
    0,
  );
  const totalDerivativeBytes = data.blobs.reduce(
    (sum, blob) => sum + numberValue(blob.derivatives?.totalBytes),
    0,
  );
  return `
    <div class="status-strip compact">
      <span class="status-pill tone-info">${dot("info")} ${escapeHtml(detail)}</span>
      <span class="status-pill tone-info">${dot("info")} ${escapeHtml(formatBytes(totalBytes))} listed</span>
      <span class="status-pill tone-info">${dot("info")} ${escapeHtml(totalDerivatives)} derivatives / ${escapeHtml(formatBytes(totalDerivativeBytes))}</span>
      <span class="status-pill tone-info">${dot("info")} ${escapeHtml(data.ownerId || "all owners")}</span>
      <span class="status-pill tone-info">${dot("info")} limit ${escapeHtml(data.limit)}</span>
    </div>
  `;
}

function blobTable(data) {
  if (!data) {
    if (state.errors.dashboardBlobs?.skipped) {
      return `<div class="empty-state">Add a bearer token to load blob metadata.</div>`;
    }
    return `<div class="empty-state">No blob metadata loaded yet.</div>`;
  }
  if (!data.blobs.length) {
    return `<div class="empty-state">No blobs visible for ${escapeHtml(data.tenantId)}.</div>`;
  }
  return `
    <div class="object-table-wrap">
      <table class="table">
        <thead><tr><th>Blob</th><th>Owner</th><th>MIME</th><th>Size</th><th>Derivatives</th><th>Hash</th><th>Created</th></tr></thead>
        <tbody>
          ${data.blobs
            .map((blob) => `
              <tr>
                <td><code class="code-inline">${escapeHtml(blob.blobId)}</code></td>
                <td>${escapeHtml(blob.ownerId)}</td>
                <td>${escapeHtml(blob.mimeType)}</td>
                <td>${escapeHtml(formatBytes(blob.byteLength))}</td>
                <td>${formatDerivativeSummary(blob.derivatives)}</td>
                <td><code class="code-inline">${escapeHtml(shortHash(blob.contentHash))}</code></td>
                <td>${escapeHtml(new Date(blob.createdAt).toLocaleString())}</td>
              </tr>
            `)
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function formatDerivativeSummary(summary = {}) {
  const count = numberValue(summary.count);
  if (!count) {
    return `<span class="status-tag tone-info">${dot("info")} none</span>`;
  }
  const processors = (summary.processors || []).join(", ") || "unknown processor";
  const mimeTypes = (summary.mimeTypes || []).join(", ") || "unknown MIME";
  const metadata = summary.hasMetadata ? "metadata present" : "metadata absent";
  return `
    <span class="status-tag tone-info">${dot("info")} ${escapeHtml(count)} / ${escapeHtml(formatBytes(summary.totalBytes))}</span>
    <div class="table-note">${escapeHtml(processors)}</div>
    <div class="table-note">${escapeHtml(mimeTypes)} · ${escapeHtml(metadata)}</div>
  `;
}

function renderJobs() {
  const jobs = state.data.jobs;
  const counts = jobs?.counts || {};
  const handlers = jobs?.registeredHandlers || [];
  const rows = Object.entries(counts).map(([status, count]) => [status, `${count} jobs`]);
  return `
    ${pageHeader("Jobs", "Inspect registered job handlers, worker state, and durable queue status counts.")}
    ${statusStrip()}
    <div class="dashboard-grid">
      <div class="primary-stack">
        <section class="metric-grid">
          ${metricCard("Worker", jobs?.workerEnabled ? "enabled" : "unknown", "Server-side durable worker status", jobs?.workerEnabled ? "good" : "warn")}
          ${metricCard("Handlers", handlers.length, handlers.join(", ") || "No handlers reported", handlers.length ? "good" : "warn")}
          ${metricCard("Queued statuses", Object.keys(counts).length, "Distinct job states in storage", Object.keys(counts).length ? "good" : "info")}
        </section>
        ${dashboardJobsPanel()}
        <div class="split-panel">
          ${definitionListPanel("Registered handlers", handlers.map((handler) => [handler, "job handler"]))}
          ${definitionListPanel("Queue counts", rows)}
        </div>
        ${activityPanel(10)}
      </div>
      ${serverInspector()}
    </div>
  `;
}

function dashboardJobsPanel() {
  if (!isMountedDashboard()) {
    return `
      <section class="panel">
        <header class="panel-header">
          <div>
            <span class="panel-kicker">Queue</span>
            <h2 class="panel-title">Recent jobs</h2>
          </div>
        </header>
        <div class="panel-body">
          <div class="empty-state">Mount Fricken Dashboard at /_frick/dashboard to browse sanitized job rows from the server origin.</div>
        </div>
      </section>
    `;
  }

  const dashboardJobs = state.data.dashboardJobs;
  const error = state.errors.dashboardJobs;
  const selectedTenantId = selectedDashboardTenantId();
  return `
    <section class="panel">
      <header class="panel-header">
        <div>
          <span class="panel-kicker">Queue</span>
          <h2 class="panel-title">Recent jobs</h2>
        </div>
        ${
          dashboardJobs
            ? `<span class="status-tag tone-info">${dot("info")} ${escapeHtml(dashboardJobs.scope)}${dashboardJobs.tenantId ? ` / ${escapeHtml(dashboardJobs.tenantId)}` : ""}</span>`
            : ""
        }
      </header>
      <div class="panel-body">
        <form class="form-grid" data-form="job-filter">
          <label class="form-row">
            <span class="field-label">Tenant</span>
            <input class="text-input" name="tenantId" value="${escapeHtml(selectedTenantId)}" placeholder="_default" autocomplete="off" />
          </label>
          <label class="form-row">
            <span class="field-label">Status</span>
            <select class="select-input" name="status">
              ${jobStatusOptions()}
            </select>
          </label>
          <label class="form-row">
            <span class="field-label">Job type</span>
            <span class="inline-fields">
              <input class="text-input" name="jobType" value="${escapeHtml(state.jobType)}" placeholder="blob.process" autocomplete="off" />
              <button class="button secondary" type="submit">${icon("check")} Apply</button>
            </span>
          </label>
        </form>
        ${error ? `<div class="error-box">${escapeHtml(error.message)}</div>` : ""}
        ${dashboardJobs ? jobsSummary(dashboardJobs) : ""}
        ${jobsTable(dashboardJobs)}
      </div>
    </section>
  `;
}

function jobStatusOptions() {
  const options = [
    ["", "Any status"],
    ["ready", "Ready"],
    ["running", "Running"],
    ["completed", "Completed"],
    ["dead_lettered", "Dead lettered"],
  ];
  return options
    .map(([value, label]) => `
      <option value="${escapeHtml(value)}"${state.jobStatus === value ? " selected" : ""}>${escapeHtml(label)}</option>
    `)
    .join("");
}

function jobsSummary(data) {
  const detail = data.truncated
    ? `${data.count} visible jobs, more available`
    : `${data.count} visible jobs`;
  return `
    <div class="status-strip compact">
      <span class="status-pill tone-info">${dot("info")} ${escapeHtml(detail)}</span>
      <span class="status-pill tone-info">${dot("info")} ${escapeHtml(data.status || "all statuses")}</span>
      <span class="status-pill tone-info">${dot("info")} ${escapeHtml(data.jobType || "all job types")}</span>
      <span class="status-pill tone-info">${dot("info")} limit ${escapeHtml(data.limit)}</span>
    </div>
  `;
}

function jobsTable(data) {
  if (!data) {
    if (state.errors.dashboardJobs?.skipped) {
      return `<div class="empty-state">Add a bearer token to load job rows.</div>`;
    }
    return `<div class="empty-state">No job rows loaded yet.</div>`;
  }
  if (!data.jobs.length) {
    return `<div class="empty-state">No jobs match the current filters.</div>`;
  }
  return `
    <div class="object-table-wrap">
      <table class="table">
        <thead><tr><th>ID</th><th>Type</th><th>Status</th><th>Attempts</th><th>Schedule</th><th>Last state</th></tr></thead>
        <tbody>
          ${data.jobs
            .map((job) => `
              <tr>
                <td><code class="code-inline">#${escapeHtml(job.id)}</code></td>
                <td>
                  <code class="code-inline">${escapeHtml(job.jobType)}</code>
                  <div class="table-note">${escapeHtml(job.tenantId)}</div>
                </td>
                <td><span class="status-tag ${toneClass(jobStatusTone(job.status))}">${dot(jobStatusTone(job.status))} ${escapeHtml(job.status)}</span></td>
                <td>${escapeHtml(job.attemptCount)} / ${escapeHtml(job.maxAttempts)}</td>
                <td>
                  ${escapeHtml(new Date(job.availableAt).toLocaleString())}
                  <div class="table-note">created ${escapeHtml(formatAge(job.createdAt))}</div>
                </td>
                <td>${formatJobLastState(job)}</td>
              </tr>
            `)
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function jobStatusTone(status) {
  if (status === "completed") return "good";
  if (status === "dead_lettered") return "bad";
  if (status === "running") return "warn";
  return "info";
}

function formatJobLastState(job) {
  const timestamp = job.deadLetteredAt || job.completedAt || job.failedAt || job.claimedAt || job.createdAt;
  const details = [];
  if (job.lastErrorCode) details.push(job.lastErrorCode);
  return `
    ${escapeHtml(formatAge(timestamp))}
    ${details.map((detail) => `<div class="table-note">${escapeHtml(detail)}</div>`).join("")}
  `;
}

function renderObservability() {
  const platformEvents = platformEventsHealth();
  const analytics = analyticsSummary();
  return `
    ${pageHeader("Observability", "Read metric snapshots and the retained DevTools event feed from the running server.")}
    ${statusStrip()}
    <div class="dashboard-grid">
      <div class="primary-stack">
        <section class="metric-grid">
          ${metricCard(
            "Pipeline",
            platformEvents ? platformEvents.adapter : "not loaded",
            platformEvents ? `${platformEvents.retained} retained events` : platformEventsUnavailableDetail(),
            platformEvents?.ok ? "good" : platformEvents ? "bad" : "warn",
          )}
          ${metricCard(
            "Pending events",
            platformEvents?.pending ?? 0,
            `${platformEvents?.claimed ?? 0} claimed, ${platformEvents?.unclaimed ?? 0} unclaimed`,
            platformEvents?.pending ? "warn" : platformEvents ? "good" : "info",
          )}
          ${metricCard(
            "Dead letters",
            platformEvents?.deadLettered ?? 0,
            `${platformEvents?.consumers?.length ?? 0} consumers tracked`,
            platformEvents?.deadLettered ? "bad" : platformEvents ? "good" : "info",
          )}
          ${metricCard(
            "Analytics events",
            analytics?.totals?.events ?? 0,
            analytics
              ? `${analytics.totals.uniqueTenants} tenants, ${analytics.totals.uniqueUsers} users`
              : analyticsUnavailableDetail(),
            analytics?.totals?.events ? "good" : analytics ? "info" : "warn",
          )}
        </section>
        ${analyticsPanel()}
        <section class="panel">
          <header class="panel-header">
            <div>
              <span class="panel-kicker">Filter</span>
              <h2 class="panel-title">Event feed</h2>
            </div>
          </header>
          <div class="panel-body">
            <form class="form-grid" data-form="event-filter">
              <label class="form-row">
                <span class="field-label">Kind contains</span>
                <span class="inline-fields">
                  <input class="text-input" name="eventFilter" value="${escapeHtml(state.eventFilter)}" placeholder="http.request, ws.connect, frick.push" autocomplete="off" />
                  <button class="button primary" type="submit">${icon("refresh")} Apply</button>
                </span>
              </label>
            </form>
          </div>
          <div class="panel-body">${eventRows(20)}</div>
        </section>
        <div class="split-panel">
          ${barChart("HTTP requests by status", requestRows(), "No HTTP metrics returned.", "green")}
          ${barChart("WebSocket frames by kind", frameRows(), "No WebSocket frame metrics returned.", "blue")}
        </div>
        ${metricsTable()}
      </div>
      ${serverInspector()}
    </div>
  `;
}

function metricsTable() {
  const rows = [...metricEntries("counters"), ...metricEntries("gauges")];
  return `
    <section class="panel">
      <header class="panel-header">
        <div>
          <span class="panel-kicker">Snapshot</span>
          <h2 class="panel-title">Raw metric entries</h2>
        </div>
      </header>
      <div class="panel-body">
        ${
          rows.length
            ? `<table class="table">
                <thead><tr><th>Name</th><th>Fields</th><th>Value</th></tr></thead>
                <tbody>
                  ${rows
                    .map((row) => `
                      <tr>
                        <td><code class="code-inline">${escapeHtml(row.name)}</code></td>
                        <td><code class="code-inline">${escapeHtml(JSON.stringify(row.fields || {}))}</code></td>
                        <td>${escapeHtml(row.value)}</td>
                      </tr>
                    `)
                    .join("")}
                </tbody>
              </table>`
            : `<div class="empty-state">No metrics loaded. Inspection may need a session token.</div>`
        }
      </div>
    </section>
  `;
}

function dashboardTenantsPanel() {
  if (!isMountedDashboard()) {
    return `
      <section class="panel">
        <header class="panel-header">
          <div>
            <span class="panel-kicker">Tenants</span>
            <h2 class="panel-title">Tenant directory</h2>
          </div>
        </header>
        <div class="panel-body">
          <div class="empty-state">Mount Fricken Dashboard at /_frick/dashboard to browse the tenant ledger from the server origin.</div>
        </div>
      </section>
    `;
  }

  const tenants = state.data.dashboardTenants;
  const error = state.errors.dashboardTenants;
  return `
    <section class="panel">
      <header class="panel-header">
        <div>
          <span class="panel-kicker">Tenants</span>
          <h2 class="panel-title">Tenant directory</h2>
        </div>
        ${
          tenants
            ? `<span class="status-tag tone-info">${dot("info")} ${escapeHtml(tenants.scope)} / ${escapeHtml(tenants.count)} visible</span>`
            : ""
        }
      </header>
      <div class="panel-body">
        ${error ? `<div class="error-box">${escapeHtml(error.message)}</div>` : ""}
        ${tenants ? tenantsSummary(tenants) : ""}
        ${tenantsTable(tenants)}
      </div>
    </section>
  `;
}

function tenantsSummary(data) {
  const archived = data.tenants.filter((tenant) => tenant.archivedAt).length;
  const active = data.tenants.length - archived;
  return `
    <div class="status-strip compact">
      <span class="status-pill tone-info">${dot("info")} ${escapeHtml(active)} active</span>
      <span class="status-pill ${archived ? "tone-warn" : "tone-info"}">${dot(archived ? "warn" : "info")} ${escapeHtml(archived)} archived</span>
      <span class="status-pill tone-info">${dot("info")} limit ${escapeHtml(data.limit)}</span>
    </div>
  `;
}

function tenantsTable(data) {
  if (!data) {
    if (state.errors.dashboardTenants?.skipped) {
      return `<div class="empty-state">Add a bearer token to load the tenant directory.</div>`;
    }
    return `<div class="empty-state">No tenant data loaded yet.</div>`;
  }
  if (!data.tenants.length) {
    return `<div class="empty-state">No tenants visible for this credential.</div>`;
  }
  return `
    <div class="object-table-wrap">
      <table class="table">
        <thead><tr><th>Tenant</th><th>Name</th><th>Status</th><th>Created</th><th></th></tr></thead>
        <tbody>
          ${data.tenants
            .map((tenant) => {
              const archived = Boolean(tenant.archivedAt);
              return `
                <tr>
                  <td><code class="code-inline">${escapeHtml(tenant.tenantId)}</code></td>
                  <td>${escapeHtml(tenant.displayName || "Untitled")}</td>
                  <td><span class="status-tag ${archived ? "tone-warn" : "tone-good"}">${dot(archived ? "warn" : "good")} ${archived ? "archived" : "active"}</span></td>
                  <td>${escapeHtml(new Date(tenant.createdAt).toLocaleString())}</td>
                  <td class="nowrap">
                    <button class="button secondary" type="button" data-select-tenant="${escapeHtml(tenant.tenantId)}">${icon("check")} Use</button>
                  </td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function dashboardTenantSettingsPanel() {
  if (!isMountedDashboard()) {
    return `
      <section class="panel">
        <header class="panel-header">
          <div>
            <span class="panel-kicker">Settings</span>
            <h2 class="panel-title">Tenant settings</h2>
          </div>
        </header>
        <div class="panel-body">
          <div class="empty-state">Mount Fricken Dashboard at /_frick/dashboard to inspect tenant settings from the server origin.</div>
        </div>
      </section>
    `;
  }

  const settings = state.data.dashboardTenantSettings;
  const error = state.errors.dashboardTenantSettings;
  const selectedTenantId = selectedDashboardTenantId();
  return `
    <section class="panel">
      <header class="panel-header">
        <div>
          <span class="panel-kicker">Settings</span>
          <h2 class="panel-title">Tenant settings</h2>
        </div>
        ${
          settings
            ? `<span class="status-tag tone-info">${dot("info")} ${escapeHtml(settings.scope)} / ${escapeHtml(settings.tenantId)}</span>`
            : ""
        }
      </header>
      <div class="panel-body">
        <form class="tenant-filter" data-form="tenant-settings">
          <label class="form-row">
            <span class="field-label">Tenant</span>
            <span class="inline-fields">
              <input class="text-input" name="tenantId" value="${escapeHtml(selectedTenantId)}" placeholder="_default" autocomplete="off" />
              <button class="button secondary" type="submit">${icon("check")} Apply</button>
            </span>
          </label>
        </form>
        ${error ? `<div class="error-box">${escapeHtml(error.message)}</div>` : ""}
        ${settings ? tenantSettingsSummary(settings) : ""}
        ${tenantSettingsTables(settings)}
      </div>
    </section>
  `;
}

function tenantSettingsSummary(data) {
  const configuredPush = ["apns", "fcm", "webPush"]
    .filter((platform) => data.settings.push?.[platform]?.configured)
    .length;
  const retention = data.settings.retentionMs === undefined
    ? "default retention"
    : `${data.settings.retentionMs}ms retention`;
  return `
    <div class="status-strip compact">
      <span class="status-pill tone-info">${dot("info")} ${escapeHtml(retention)}</span>
      <span class="status-pill ${configuredPush ? "tone-good" : "tone-info"}">${dot(configuredPush ? "good" : "info")} ${escapeHtml(configuredPush)} push credentials</span>
      <span class="status-pill ${data.settings.redactedKeys.length ? "tone-warn" : "tone-info"}">${dot(data.settings.redactedKeys.length ? "warn" : "info")} ${escapeHtml(data.settings.redactedKeys.length)} redacted keys</span>
    </div>
  `;
}

function tenantSettingsTables(data) {
  if (!data) {
    if (state.errors.dashboardTenantSettings?.skipped) {
      return `<div class="empty-state">Add a bearer token to load tenant settings.</div>`;
    }
    return `<div class="empty-state">No tenant settings loaded yet.</div>`;
  }
  return `
    <div class="split-panel">
      ${tenantLimitsTable(data.settings.limits)}
      ${pushCredentialsTable(data.settings.push)}
    </div>
    ${tenantSettingKeysTable(data.settings)}
  `;
}

function tenantLimitsTable(limits = {}) {
  const rows = Object.entries(limits);
  return `
    <div class="object-table-wrap">
      <table class="table">
        <thead><tr><th>Limit</th><th>Override</th></tr></thead>
        <tbody>
          ${
            rows.length
              ? rows
                  .map(([key, value]) => `
                    <tr>
                      <td><code class="code-inline">${escapeHtml(key)}</code></td>
                      <td>${escapeHtml(value)}</td>
                    </tr>
                  `)
                  .join("")
              : `<tr><td colspan="2">No per-tenant limit overrides.</td></tr>`
          }
        </tbody>
      </table>
    </div>
  `;
}

function pushCredentialsTable(push = {}) {
  return `
    <div class="object-table-wrap">
      <table class="table">
        <thead><tr><th>Push platform</th><th>Status</th></tr></thead>
        <tbody>
          ${["apns", "fcm", "webPush"]
            .map((platform) => {
              const configured = Boolean(push[platform]?.configured);
              return `
                <tr>
                  <td><code class="code-inline">${escapeHtml(platform)}</code></td>
                  <td><span class="status-tag ${configured ? "tone-good" : "tone-info"}">${dot(configured ? "good" : "info")} ${configured ? "configured" : "not configured"}</span></td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function tenantSettingKeysTable(settings) {
  const rows = settings.configuredKeys;
  if (!rows.length) {
    return `<div class="empty-state">No tenant settings stored for ${escapeHtml(state.data.dashboardTenantSettings?.tenantId || "this tenant")}.</div>`;
  }
  return `
    <div class="object-table-wrap">
      <table class="table">
        <thead><tr><th>Stored key</th><th>Dashboard treatment</th></tr></thead>
        <tbody>
          ${rows
            .map((key) => {
              const redacted = settings.redactedKeys.includes(key);
              const known = !settings.otherKeys.includes(key);
              const tone = redacted ? "warn" : known ? "good" : "info";
              const treatment = redacted ? "redacted" : known ? "summarized" : "key only";
              return `
                <tr>
                  <td><code class="code-inline">${escapeHtml(key)}</code></td>
                  <td><span class="status-tag ${toneClass(tone)}">${dot(tone)} ${escapeHtml(treatment)}</span></td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderSettings() {
  return `
    ${pageHeader("Settings", "Configure the local server endpoint and the credential used for inspection routes.")}
    ${statusStrip()}
    <div class="dashboard-grid">
      <div class="primary-stack">
        <section class="panel">
          <header class="panel-header">
            <div>
              <span class="panel-kicker">Connection</span>
              <h2 class="panel-title">Local endpoint</h2>
            </div>
          </header>
          <div class="panel-body">
            <form class="form-grid" data-form="endpoint">
              <label class="form-row">
                <span class="field-label">Frick HTTP endpoint</span>
                <input class="text-input" name="endpoint" value="${escapeHtml(state.endpoint)}" autocomplete="off" />
              </label>
              <button class="button primary" type="submit">${icon("check")} Save endpoint</button>
            </form>
          </div>
        </section>
        ${dashboardTenantsPanel()}
        ${dashboardTenantSettingsPanel()}
        ${definitionListPanel("Dashboard facts", [
          ["Static app", `Served from apps/dev-dashboard on port ${DASHBOARD_PORT}`],
          ["Inspection auth", "Bearer token or dev session required"],
          ["Default server", DEFAULT_ENDPOINT],
          ["Tenant directory", "Read-only mounted dashboard API"],
          ["Tenant settings", "Sanitized settings summary"],
          ["Generated artifacts", "Not edited by this dashboard"],
        ])}
      </div>
      ${serverInspector()}
    </div>
  `;
}

function pageHeader(title, copy) {
  return `
    <header class="page-header">
      <div>
        <h1 class="page-title">${escapeHtml(title)}</h1>
        <p class="page-copy">${escapeHtml(copy)}</p>
      </div>
      <button class="button primary" type="button" data-action="refresh">${icon("refresh")} Refresh</button>
    </header>
  `;
}

function renderRoute() {
  const routes = {
    overview: renderOverview,
    realtime: renderRealtime,
    data: renderData,
    auth: renderAuth,
    storage: renderStorage,
    jobs: renderJobs,
    observability: renderObservability,
    settings: renderSettings,
  };
  return (routes[state.route] || renderOverview)();
}

function render() {
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-mark">F</span>
          <span>
            <strong>Fricken Dashboard</strong>
            <small>Realtime console</small>
          </span>
        </div>
        <section class="project-card">
          <span>Project</span>
          <strong>Frick Foundation</strong>
        </section>
        <nav class="nav" aria-label="Dashboard">
          ${navItems
            .map((item) => `
              <button class="nav-button" type="button" data-route="${escapeHtml(item.id)}" aria-current="${state.route === item.id ? "page" : "false"}">
                ${icon(item.icon)}
                <span>${escapeHtml(item.label)}</span>
              </button>
            `)
            .join("")}
        </nav>
        <section class="sidebar-footer">
          <span>Endpoint</span>
          <code>${escapeHtml(state.endpoint)}</code>
        </section>
      </aside>
      <section class="workspace">
        <header class="topbar">
          <div class="topbar-title">
            <span>Frick Foundation</span>
            <strong>${escapeHtml(routeTitle())}</strong>
          </div>
          <div class="topbar-actions">
            <label class="endpoint-control" title="Server endpoint">
              ${icon("link")}
              <input id="endpoint-input" value="${escapeHtml(state.endpoint)}" autocomplete="off" />
            </label>
            <label class="token-control" data-has-token="${Boolean(state.token)}" title="Inspection bearer token">
              ${icon("lock")}
              <input id="token-input" value="${escapeHtml(state.token)}" type="password" autocomplete="off" placeholder="Session token" />
            </label>
            <button class="icon-button" type="button" data-action="refresh" title="Refresh">${icon("refresh")}</button>
            <a class="button secondary" href="http://127.0.0.1:5173" target="_blank" rel="noopener">${icon("window")} Web demo</a>
          </div>
        </header>
        <main class="content">${renderRoute()}</main>
      </section>
    </div>
  `;
  bindControls();
}

function bindControls() {
  app.querySelectorAll("[data-route]").forEach((button) => {
    button.addEventListener("click", () => {
      state.route = normalizeRoute(button.dataset.route);
      localStorage.setItem(STORAGE_KEYS.route, state.route);
      history.replaceState(null, "", `#${state.route}`);
      render();
    });
  });

  app.querySelectorAll("[data-action='refresh']").forEach((button) => {
    button.addEventListener("click", () => void refreshData());
  });

  app.querySelectorAll("[data-event-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedEventId = Number(button.dataset.eventId);
      render();
    });
  });

  app.querySelectorAll("[data-object-type]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedObjectType = button.dataset.objectType || "";
      if (state.selectedObjectType) localStorage.setItem(STORAGE_KEYS.objectType, state.selectedObjectType);
      else localStorage.removeItem(STORAGE_KEYS.objectType);
      void refreshData();
    });
  });

  app.querySelectorAll("[data-select-tenant]").forEach((button) => {
    button.addEventListener("click", () => {
      state.dataTenantId = button.dataset.selectTenant || "";
      if (state.dataTenantId) localStorage.setItem(STORAGE_KEYS.tenantId, state.dataTenantId);
      else localStorage.removeItem(STORAGE_KEYS.tenantId);
      void refreshData();
    });
  });

  const endpointInput = app.querySelector("#endpoint-input");
  if (endpointInput) {
    endpointInput.addEventListener("change", () => {
      state.endpoint = endpointInput.value.trim() || DEFAULT_ENDPOINT;
      localStorage.setItem(STORAGE_KEYS.endpoint, state.endpoint);
      void refreshData();
    });
  }

  const tokenInput = app.querySelector("#token-input");
  if (tokenInput) {
    tokenInput.addEventListener("change", () => {
      state.token = tokenInput.value.trim();
      if (state.token) localStorage.setItem(STORAGE_KEYS.token, state.token);
      else localStorage.removeItem(STORAGE_KEYS.token);
      void refreshData();
    });
  }

  const devLoginForm = app.querySelector("[data-form='dev-login']");
  if (devLoginForm) {
    devLoginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      state.devUserId = new FormData(devLoginForm).get("devUserId")?.toString().trim() || "user-ada";
      state.errors = { ...state.errors, devLogin: undefined };
      try {
        await devLogin();
      } catch (error) {
        state.errors = { ...state.errors, devLogin: error };
        render();
      }
    });
  }

  const tokenForm = app.querySelector("[data-form='token']");
  if (tokenForm) {
    tokenForm.addEventListener("submit", (event) => {
      event.preventDefault();
      state.token = new FormData(tokenForm).get("token")?.toString().trim() || "";
      if (state.token) localStorage.setItem(STORAGE_KEYS.token, state.token);
      else localStorage.removeItem(STORAGE_KEYS.token);
      void refreshData();
    });
  }

  const endpointForm = app.querySelector("[data-form='endpoint']");
  if (endpointForm) {
    endpointForm.addEventListener("submit", (event) => {
      event.preventDefault();
      state.endpoint = new FormData(endpointForm).get("endpoint")?.toString().trim() || DEFAULT_ENDPOINT;
      localStorage.setItem(STORAGE_KEYS.endpoint, state.endpoint);
      void refreshData();
    });
  }

  const eventFilterForm = app.querySelector("[data-form='event-filter']");
  if (eventFilterForm) {
    eventFilterForm.addEventListener("submit", (event) => {
      event.preventDefault();
      state.eventFilter = new FormData(eventFilterForm).get("eventFilter")?.toString().trim() || "";
      void refreshData();
    });
  }

  const objectTenantForm = app.querySelector("[data-form='object-tenant']");
  if (objectTenantForm) {
    objectTenantForm.addEventListener("submit", (event) => {
      event.preventDefault();
      state.dataTenantId = new FormData(objectTenantForm).get("tenantId")?.toString().trim() || "";
      if (state.dataTenantId) localStorage.setItem(STORAGE_KEYS.tenantId, state.dataTenantId);
      else localStorage.removeItem(STORAGE_KEYS.tenantId);
      void refreshData();
    });
  }

  const tenantSettingsForm = app.querySelector("[data-form='tenant-settings']");
  if (tenantSettingsForm) {
    tenantSettingsForm.addEventListener("submit", (event) => {
      event.preventDefault();
      state.dataTenantId = new FormData(tenantSettingsForm).get("tenantId")?.toString().trim() || "";
      if (state.dataTenantId) localStorage.setItem(STORAGE_KEYS.tenantId, state.dataTenantId);
      else localStorage.removeItem(STORAGE_KEYS.tenantId);
      void refreshData();
    });
  }

  const blobFilterForm = app.querySelector("[data-form='blob-filter']");
  if (blobFilterForm) {
    blobFilterForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = new FormData(blobFilterForm);
      state.dataTenantId = form.get("tenantId")?.toString().trim() || "";
      state.blobOwnerId = form.get("ownerId")?.toString().trim() || "";
      if (state.dataTenantId) localStorage.setItem(STORAGE_KEYS.tenantId, state.dataTenantId);
      else localStorage.removeItem(STORAGE_KEYS.tenantId);
      if (state.blobOwnerId) localStorage.setItem(STORAGE_KEYS.blobOwnerId, state.blobOwnerId);
      else localStorage.removeItem(STORAGE_KEYS.blobOwnerId);
      void refreshData();
    });
  }

  const jobFilterForm = app.querySelector("[data-form='job-filter']");
  if (jobFilterForm) {
    jobFilterForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = new FormData(jobFilterForm);
      state.dataTenantId = form.get("tenantId")?.toString().trim() || "";
      state.jobStatus = form.get("status")?.toString().trim() || "";
      state.jobType = form.get("jobType")?.toString().trim() || "";
      if (state.dataTenantId) localStorage.setItem(STORAGE_KEYS.tenantId, state.dataTenantId);
      else localStorage.removeItem(STORAGE_KEYS.tenantId);
      if (state.jobStatus) localStorage.setItem(STORAGE_KEYS.jobStatus, state.jobStatus);
      else localStorage.removeItem(STORAGE_KEYS.jobStatus);
      if (state.jobType) localStorage.setItem(STORAGE_KEYS.jobType, state.jobType);
      else localStorage.removeItem(STORAGE_KEYS.jobType);
      void refreshData();
    });
  }

  app.querySelectorAll("[data-action='clear-token']").forEach((button) => {
    button.addEventListener("click", () => {
      state.token = "";
      localStorage.removeItem(STORAGE_KEYS.token);
      void refreshData();
    });
  });
}

window.addEventListener("hashchange", () => {
  state.route = normalizeRoute(location.hash.slice(1));
  localStorage.setItem(STORAGE_KEYS.route, state.route);
  render();
});

render();
void refreshData();
