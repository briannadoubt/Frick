/**
 * Pluggable outbound email surface.
 *
 * Mirrors the push-adapter pattern: the framework defines an interface,
 * apps register an implementation at boot, and the framework's
 * verification / password-reset flows call into it. Keeps credential-
 * bearing dependencies (Resend, SES, Postmark) out of the core bundle.
 *
 * `send(message)` returns a {@link FrickEmailDelivery} so the caller can
 * log + audit the attempt. Adapters should be defensive — a thrown
 * exception is treated as a `status: "failed"` with
 * `error.code = "adapter.threw"` by the router so a buggy adapter can't
 * tear down the auth flow that triggered it.
 */

import type { FrickLogger } from "../logger.js";

export interface FrickEmailMessage {
  readonly to: string;
  readonly from: string;
  readonly subject: string;
  /** Plain-text body. Required so every adapter can deliver something. */
  readonly text: string;
  /** Optional HTML body. Adapters that support multipart will use both. */
  readonly html?: string;
  /** Free-form metadata for adapter routing / observability. */
  readonly tags?: Record<string, string>;
}

export interface FrickEmailDelivery {
  readonly attemptedAt: string;
  readonly status: "delivered" | "failed";
  /** Provider message id, if the adapter returns one. */
  readonly receiptId?: string;
  readonly error?: { code: string; message: string };
}

export interface FrickEmailContext {
  readonly tenantId: string;
  readonly logger: FrickLogger;
}

export interface FrickEmailAdapter {
  /** Identifier for adapter selection. */
  readonly provider: string;
  send(message: FrickEmailMessage, ctx: FrickEmailContext): Promise<FrickEmailDelivery>;
}
