import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface DashboardHarness {
  readonly calls: Array<{ url: string; headers: Record<string, string> }>;
  fetchAnalyticsSummary(): Promise<unknown>;
  fetchPlatformEventsHealth(): Promise<unknown>;
  fetchDashboardAccounts(): Promise<unknown>;
  fetchDashboardTenants(): Promise<unknown>;
  fetchDashboardTenantSettings(): Promise<unknown>;
  fetchDashboardBlobs(): Promise<unknown>;
}

describe("dev dashboard script", () => {
  it("uses inspection analytics and platform-event routes when served standalone", async () => {
    const dashboard = loadDashboardScript({ pathname: "/" });

    await dashboard.fetchAnalyticsSummary();
    await dashboard.fetchPlatformEventsHealth();
    await dashboard.fetchDashboardAccounts();
    await dashboard.fetchDashboardTenants();
    await dashboard.fetchDashboardTenantSettings();
    await dashboard.fetchDashboardBlobs();

    expect(dashboard.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/_frick/inspect/analytics/summary",
      "/_frick/inspect/platform-events",
    ]);
    expect(dashboard.calls.every((call) => call.headers.authorization === "Bearer token-ada")).toBe(true);
  });

  it("keeps same-origin dashboard APIs when served mounted", async () => {
    const dashboard = loadDashboardScript({ pathname: "/_frick/dashboard/" });

    await dashboard.fetchAnalyticsSummary();
    await dashboard.fetchPlatformEventsHealth();
    await dashboard.fetchDashboardAccounts();
    await dashboard.fetchDashboardTenants();
    await dashboard.fetchDashboardTenantSettings();
    await dashboard.fetchDashboardBlobs();

    expect(dashboard.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/_frick/dashboard/api/analytics/summary",
      "/_frick/dashboard/api/platform-events/health",
      "/_frick/dashboard/api/accounts",
      "/_frick/dashboard/api/tenants",
      "/_frick/dashboard/api/tenant-settings",
      "/_frick/dashboard/api/blobs",
    ]);
  });
});

function loadDashboardScript(input: { pathname: string }): DashboardHarness {
  const source = readFileSync(new URL("../../dev-dashboard/dashboard.js", import.meta.url), "utf8")
    .replace(/\nrender\(\);\nvoid refreshData\(\);\s*$/, "");
  const calls: DashboardHarness["calls"] = [];
  const app = {
    innerHTML: "",
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const storage = new Map<string, string>([
    ["fricken-dashboard:token", "token-ada"],
  ]);
  const location = {
    origin: "http://127.0.0.1:4299",
    pathname: input.pathname,
    search: "",
    hash: "",
  };

  const factory = new Function(
    "document",
    "location",
    "localStorage",
    "fetch",
    "history",
    "window",
    `${source}
return { fetchAnalyticsSummary, fetchPlatformEventsHealth, fetchDashboardAccounts, fetchDashboardTenants, fetchDashboardTenantSettings, fetchDashboardBlobs };`,
  ) as (
    document: unknown,
    location: unknown,
    localStorage: unknown,
    fetch: unknown,
    history: unknown,
    window: unknown,
  ) => Pick<DashboardHarness, "fetchAnalyticsSummary" | "fetchPlatformEventsHealth" | "fetchDashboardAccounts" | "fetchDashboardTenants" | "fetchDashboardTenantSettings" | "fetchDashboardBlobs">;

  const api = factory(
    { getElementById: () => app },
    location,
    {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    async (url: URL | string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url: String(url), headers: init?.headers ?? {} });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "{}",
      };
    },
    { replaceState: () => undefined },
    { addEventListener: () => undefined },
  );

  return {
    calls,
    ...api,
  };
}
