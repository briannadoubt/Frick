/**
 * Resend HTTP adapter. Uses the v1 `POST /emails` endpoint with a
 * bearer-token auth header.
 *
 * Configuration:
 *   - `apiKey` (required, defaults to `process.env.RESEND_API_KEY`).
 *   - `endpoint` override for tests (defaults to `https://api.resend.com`).
 *
 * Maps:
 *   - 2xx → `delivered` with the `id` from the response body as receipt.
 *   - 4xx without `name` → `email.invalidRequest`.
 *   - 401 / 403 → `email.unauthorized`.
 *   - 429 → `email.rateLimited`.
 *   - 5xx → `email.serverError`.
 *
 * Adapter does not throw on HTTP failure — every failure path returns a
 * structured delivery so the router's audit emits the same shape.
 */

import type {
  FrickEmailAdapter,
  FrickEmailContext,
  FrickEmailDelivery,
  FrickEmailMessage,
} from "./types.js";

const DEFAULT_ENDPOINT = "https://api.resend.com";

export interface ResendAdapterOptions {
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly fetch?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
}

export interface FrickResendEmailAdapter extends FrickEmailAdapter {
  readonly provider: "resend";
}

export function createFrickResendEmailAdapter(options: ResendAdapterOptions = {}): FrickResendEmailAdapter {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const resolveApiKey = (): string | undefined => options.apiKey ?? env.RESEND_API_KEY;

  return {
    provider: "resend",
    async send(message: FrickEmailMessage, _ctx: FrickEmailContext): Promise<FrickEmailDelivery> {
      const apiKey = resolveApiKey();
      const attemptedAt = new Date().toISOString();
      if (!apiKey) {
        return {
          attemptedAt,
          status: "failed",
          error: { code: "email.unauthorized", message: "RESEND_API_KEY is unset" },
        };
      }
      const body = JSON.stringify({
        to: message.to,
        from: message.from,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(message.tags ? { tags: Object.entries(message.tags).map(([name, value]) => ({ name, value })) } : {}),
      });
      let response: Response;
      try {
        response = await fetchImpl(`${endpoint.replace(/\/$/, "")}/emails`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body,
        });
      } catch (err) {
        return {
          attemptedAt,
          status: "failed",
          error: { code: "email.networkError", message: err instanceof Error ? err.message : String(err) },
        };
      }
      const text = await response.text();
      if (response.status >= 200 && response.status < 300) {
        let receiptId: string | undefined;
        try {
          const parsed = JSON.parse(text) as { id?: string };
          receiptId = parsed.id;
        } catch {
          /* swallow */
        }
        return {
          attemptedAt,
          status: "delivered",
          ...(receiptId ? { receiptId } : {}),
        };
      }
      return {
        attemptedAt,
        status: "failed",
        error: {
          code: mapStatus(response.status),
          message: `Resend ${response.status}: ${text.slice(0, 200)}`,
        },
      };
    },
  };
}

function mapStatus(status: number): string {
  if (status === 401 || status === 403) return "email.unauthorized";
  if (status === 429) return "email.rateLimited";
  if (status >= 500) return "email.serverError";
  if (status >= 400) return "email.invalidRequest";
  return "email.deliveryFailed";
}
