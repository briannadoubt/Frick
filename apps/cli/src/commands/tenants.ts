/**
 * `frick tenants list` — list rows in the `tenants` ledger.
 * `frick tenants create <id> [--display-name <name>]` — insert a tenant row.
 * `frick tenants set-push <id> --platform apns --p8 <file> --key-id ... --team-id ... --bundle-id ...` —
 *     wrap APNs credentials with `FRICK_PUSH_CRED_KEY` and store in `tenant_settings`.
 * `frick tenants set-push <id> --platform fcm --service-account <file>` —
 *     wrap FCM service-account JSON and store in `tenant_settings`.
 * `frick tenants set-push <id> --platform webpush --subject <mailto:|https:> --public-key <b64url> --private-key <pem-file>` —
 *     wrap Web Push VAPID credentials and store in `tenant_settings`.
 */
import { readFileSync } from "node:fs";
import {
  TenantAlreadyExistsError,
  saveApnsCredentials,
  saveFcmCredentials,
  saveWebPushCredentials,
} from "@fricken/server";
import type { ParsedArgs } from "../argv.js";
import { CliFailureError, CliUsageError } from "../errors.js";
import { contextFlagsFrom, loadConfig, openStore } from "../context.js";
import { emit, type OutputOptions } from "../output.js";
import { requireString } from "../argv.js";

export async function tenantsCommand(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === "list") return tenantsList(parsed, out);
  if (sub === "create") return tenantsCreate(parsed, out);
  if (sub === "set-push") return tenantsSetPush(parsed, out);
  throw new CliUsageError(`Unknown tenants subcommand: ${sub ?? "<missing>"}`, {
    expected: ["list", "create", "set-push"],
  });
}

async function tenantsList(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const config = loadConfig(contextFlagsFrom(parsed.flags));
  const store = openStore(config);
  try {
    const includeArchived = parsed.flags["include-archived"] === true;
    const rows = await store.tenants.list(includeArchived);
    emit({ tenants: rows }, out);
    return 0;
  } finally {
    store.close();
  }
}

function requireFlag(flags: Record<string, string | boolean>, key: string): string {
  const value = requireString(flags, key);
  if (!value) {
    throw new CliUsageError(`Missing required --${key} flag`);
  }
  return value;
}

async function tenantsSetPush(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const tenantId = parsed.positionals[1];
  if (!tenantId) {
    throw new CliUsageError("frick tenants set-push requires a tenant id positional argument");
  }
  const platform = requireFlag(parsed.flags, "platform");
  const config = loadConfig(contextFlagsFrom(parsed.flags));
  const store = openStore(config);
  try {
    if (platform === "apns") {
      const p8Path = requireFlag(parsed.flags, "p8");
      const keyId = requireFlag(parsed.flags, "key-id");
      const teamId = requireFlag(parsed.flags, "team-id");
      const bundleId = requireFlag(parsed.flags, "bundle-id");
      const useSandbox = parsed.flags.sandbox === true;
      const privateKeyPem = readFileSync(p8Path, "utf8");
      const result = await saveApnsCredentials(store.tenantSettings, tenantId, {
        keyId,
        teamId,
        bundleId,
        privateKeyPem,
        useSandbox,
      });
      if (!result.ok) {
        throw new CliFailureError(result.error.code, result.error.message, { tenantId });
      }
      emit({ ok: true, tenantId, platform: "apns" }, out);
      return 0;
    }
    if (platform === "fcm") {
      const path = requireFlag(parsed.flags, "service-account");
      const raw = readFileSync(path, "utf8");
      let parsedJson: { project_id?: string; client_email?: string; private_key?: string; token_uri?: string };
      try {
        parsedJson = JSON.parse(raw) as typeof parsedJson;
      } catch {
        throw new CliFailureError(
          "tenants.setPush.invalidServiceAccount",
          "Service-account file is not valid JSON",
          { path },
        );
      }
      if (!parsedJson.project_id || !parsedJson.client_email || !parsedJson.private_key) {
        throw new CliFailureError(
          "tenants.setPush.invalidServiceAccount",
          "Service-account file missing project_id, client_email, or private_key",
          { path },
        );
      }
      const result = await saveFcmCredentials(store.tenantSettings, tenantId, {
        projectId: parsedJson.project_id,
        clientEmail: parsedJson.client_email,
        privateKey: parsedJson.private_key,
        ...(parsedJson.token_uri ? { tokenUri: parsedJson.token_uri } : {}),
      });
      if (!result.ok) {
        throw new CliFailureError(result.error.code, result.error.message, { tenantId });
      }
      emit({ ok: true, tenantId, platform: "fcm" }, out);
      return 0;
    }
    if (platform === "webpush") {
      const subject = requireFlag(parsed.flags, "subject");
      if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) {
        throw new CliFailureError(
          "tenants.setPush.invalidVapidSubject",
          "Web Push --subject must be a mailto: or https:// URI",
          { subject },
        );
      }
      const publicKey = requireFlag(parsed.flags, "public-key");
      const privateKeyPath = requireFlag(parsed.flags, "private-key");
      const privateKey = readFileSync(privateKeyPath, "utf8");
      const result = await saveWebPushCredentials(store.tenantSettings, tenantId, {
        subject,
        publicKey,
        privateKey,
      });
      if (!result.ok) {
        throw new CliFailureError(result.error.code, result.error.message, { tenantId });
      }
      emit({ ok: true, tenantId, platform: "webpush" }, out);
      return 0;
    }
    throw new CliUsageError(`Unsupported --platform: ${platform}`, {
      expected: ["apns", "fcm", "webpush"],
    });
  } finally {
    store.close();
  }
}

async function tenantsCreate(parsed: ParsedArgs, out: OutputOptions): Promise<number> {
  const tenantId = parsed.positionals[1];
  if (!tenantId) {
    throw new CliUsageError("frick tenants create requires a tenant id positional argument");
  }
  const displayName = requireString(parsed.flags, "display-name");
  const config = loadConfig(contextFlagsFrom(parsed.flags));
  const store = openStore(config);
  try {
    const row = await store.tenants.create(tenantId, displayName);
    emit({ ok: true, tenant: row }, out);
    return 0;
  } catch (error) {
    if (error instanceof TenantAlreadyExistsError) {
      throw new CliFailureError("tenants.exists", error.message, { tenantId });
    }
    throw error;
  } finally {
    store.close();
  }
}
