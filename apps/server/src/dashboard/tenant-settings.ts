import type { Principal } from "../authz.js";
import {
  APNS_SETTINGS_KEY,
  FCM_SETTINGS_KEY,
  WEB_PUSH_SETTINGS_KEY,
} from "../push/credentials.js";
import type { FrickStore } from "../store.js";

const TENANT_LIMIT_SETTING_KEYS = [
  "maxBlobBytes",
  "maxStreamAppendPayloadBytes",
  "maxSubscriptionsPerConnection",
  "maxPendingAppendsPerClient",
] as const;

const PUSH_SETTING_KEYS = [
  APNS_SETTINGS_KEY,
  FCM_SETTINGS_KEY,
  WEB_PUSH_SETTINGS_KEY,
] as const;

type TenantLimitSettingKey = typeof TENANT_LIMIT_SETTING_KEYS[number];

export interface DashboardTenantSettings {
  readonly schemaHash: string;
  readonly tenantId: string;
  readonly scope: "tenant" | "admin";
  readonly settings: {
    readonly limits: Readonly<Partial<Record<TenantLimitSettingKey, number>>>;
    readonly retentionMs?: number;
    readonly push: {
      readonly apns: { readonly configured: boolean };
      readonly fcm: { readonly configured: boolean };
      readonly webPush: { readonly configured: boolean };
    };
    readonly configuredKeys: readonly string[];
    readonly redactedKeys: readonly string[];
    readonly otherKeys: readonly string[];
  };
}

export interface BuildDashboardTenantSettingsInput {
  readonly store: FrickStore;
  readonly principal: Principal;
  readonly tenantId?: string;
}

export function buildDashboardTenantSettings(
  input: BuildDashboardTenantSettingsInput,
): DashboardTenantSettings {
  const scope = input.principal.scope === "admin" ? "admin" : "tenant";
  const tenantId = scope === "admin"
    ? input.tenantId || input.principal.tenantId
    : input.principal.tenantId;
  const rawSettings = input.store.tenantSettings.list(tenantId);

  return {
    schemaHash: input.store.schema.hash,
    tenantId,
    scope,
    settings: sanitizeTenantSettings(rawSettings),
  };
}

function sanitizeTenantSettings(rawSettings: Record<string, unknown>): DashboardTenantSettings["settings"] {
  const configuredKeys = Object.keys(rawSettings).sort();
  const redactedKeys = configuredKeys.filter((key) => isSensitiveSettingKey(key));

  return {
    limits: sanitizeLimits(rawSettings.limits),
    ...sanitizeRetentionMs(rawSettings.retentionMs),
    push: {
      apns: { configured: isConfiguredCredential(rawSettings[APNS_SETTINGS_KEY]) },
      fcm: { configured: isConfiguredCredential(rawSettings[FCM_SETTINGS_KEY]) },
      webPush: { configured: isConfiguredCredential(rawSettings[WEB_PUSH_SETTINGS_KEY]) },
    },
    configuredKeys,
    redactedKeys,
    otherKeys: configuredKeys.filter((key) => !isKnownDashboardSettingKey(key)),
  };
}

function sanitizeLimits(rawLimits: unknown): Partial<Record<TenantLimitSettingKey, number>> {
  if (!rawLimits || typeof rawLimits !== "object" || Array.isArray(rawLimits)) {
    return {};
  }
  const limits = rawLimits as Record<string, unknown>;
  const out: Partial<Record<TenantLimitSettingKey, number>> = {};
  for (const key of TENANT_LIMIT_SETTING_KEYS) {
    const value = limits[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      out[key] = value;
    }
  }
  return out;
}

function sanitizeRetentionMs(rawRetentionMs: unknown): { retentionMs?: number } {
  if (
    typeof rawRetentionMs === "number" &&
    Number.isFinite(rawRetentionMs) &&
    rawRetentionMs >= 0
  ) {
    return { retentionMs: rawRetentionMs };
  }
  return {};
}

function isConfiguredCredential(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function isSensitiveSettingKey(key: string): boolean {
  return key.endsWith(".encrypted");
}

function isKnownDashboardSettingKey(key: string): boolean {
  return key === "limits" ||
    key === "retentionMs" ||
    PUSH_SETTING_KEYS.some((pushKey) => pushKey === key);
}
