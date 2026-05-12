/**
 * Email router.
 *
 * Thin layer over a {@link FrickEmailAdapter}: wraps the bare `send(...)`
 * call with the common framework concerns — provider exceptions become
 * structured failures, every attempt is logged + recorded in the
 * DevTools event feed so operators can read back delivery state.
 *
 * High-level helpers `sendVerificationEmail` and `sendPasswordResetEmail`
 * compose the framework's auth flows. Apps that want completely custom
 * email content can call the router's `send(...)` directly with their
 * own `FrickEmailMessage`.
 */

import type { FrickStore } from "../store.js";
import type { FrickLogger } from "../logger.js";
import type {
  FrickEmailAdapter,
  FrickEmailContext,
  FrickEmailDelivery,
  FrickEmailMessage,
} from "./types.js";

export interface FrickEmailRouter {
  /** Send a fully-formed message; logs + audits regardless of adapter outcome. */
  send(message: FrickEmailMessage, opts: { tenantId: string }): Promise<FrickEmailDelivery>;
  /** Convenience: build a verification email from the active sender + link. */
  sendVerificationEmail(opts: VerificationEmailOptions): Promise<FrickEmailDelivery>;
  /** Convenience: build a password-reset email from the active sender + link. */
  sendPasswordResetEmail(opts: PasswordResetEmailOptions): Promise<FrickEmailDelivery>;
}

export interface FrickEmailRouterOptions {
  readonly adapter: FrickEmailAdapter;
  readonly store: FrickStore;
  readonly logger: FrickLogger;
  /** Default `from:` address. Required for the verification + reset helpers. */
  readonly defaultFrom?: string;
}

export interface VerificationEmailOptions {
  readonly tenantId: string;
  readonly to: string;
  readonly verificationUrl: string;
  /** Override the `from:` address; defaults to `defaultFrom`. */
  readonly from?: string;
  readonly appName?: string;
}

export interface PasswordResetEmailOptions {
  readonly tenantId: string;
  readonly to: string;
  readonly resetUrl: string;
  readonly from?: string;
  readonly appName?: string;
}

export function createFrickEmailRouter(options: FrickEmailRouterOptions): FrickEmailRouter {
  const { adapter, store, logger, defaultFrom } = options;

  async function send(message: FrickEmailMessage, opts: { tenantId: string }): Promise<FrickEmailDelivery> {
    const ctx: FrickEmailContext = {
      tenantId: opts.tenantId,
      logger: logger.child({ provider: adapter.provider, tenantId: opts.tenantId, recipient: redactEmail(message.to) }),
    };
    let delivery: FrickEmailDelivery;
    try {
      delivery = await adapter.send(message, ctx);
    } catch (err) {
      delivery = {
        attemptedAt: new Date().toISOString(),
        status: "failed",
        error: {
          code: "adapter.threw",
          message: err instanceof Error ? err.message : String(err),
        },
      };
      ctx.logger.error("frick.email.adapter_threw", {
        event: "frick.email.adapter_threw",
        error: delivery.error?.message,
      });
    }
    store.devtoolsEvents.record({
      kind: "frick.email.delivery",
      tenantId: opts.tenantId,
      fields: {
        provider: adapter.provider,
        recipient: redactEmail(message.to),
        subject: message.subject,
        status: delivery.status,
        ...(delivery.error ? { errorCode: delivery.error.code } : {}),
        ...(delivery.receiptId ? { receiptId: delivery.receiptId } : {}),
      },
    });
    return delivery;
  }

  async function sendVerificationEmail(opts: VerificationEmailOptions): Promise<FrickEmailDelivery> {
    const from = opts.from ?? defaultFrom;
    if (!from) {
      return adapterMissingFromError();
    }
    const appName = opts.appName ?? "Your app";
    return send(
      {
        to: opts.to,
        from,
        subject: `Verify your email for ${appName}`,
        text: `Click to verify: ${opts.verificationUrl}\n\nIf you didn't request this, ignore this email.`,
        html: `<p>Click to verify: <a href="${escapeHtml(opts.verificationUrl)}">${escapeHtml(opts.verificationUrl)}</a></p><p>If you didn't request this, ignore this email.</p>`,
        tags: { kind: "verification", tenantId: opts.tenantId },
      },
      { tenantId: opts.tenantId },
    );
  }

  async function sendPasswordResetEmail(opts: PasswordResetEmailOptions): Promise<FrickEmailDelivery> {
    const from = opts.from ?? defaultFrom;
    if (!from) {
      return adapterMissingFromError();
    }
    const appName = opts.appName ?? "Your app";
    return send(
      {
        to: opts.to,
        from,
        subject: `Reset your password for ${appName}`,
        text: `Reset your password: ${opts.resetUrl}\n\nThis link expires in one hour. If you didn't request this, ignore this email.`,
        html: `<p>Reset your password: <a href="${escapeHtml(opts.resetUrl)}">${escapeHtml(opts.resetUrl)}</a></p><p>This link expires in one hour. If you didn't request this, ignore this email.</p>`,
        tags: { kind: "passwordReset", tenantId: opts.tenantId },
      },
      { tenantId: opts.tenantId },
    );
  }

  return { send, sendVerificationEmail, sendPasswordResetEmail };
}

function adapterMissingFromError(): FrickEmailDelivery {
  return {
    attemptedAt: new Date().toISOString(),
    status: "failed",
    error: { code: "email.missingFrom", message: "No `from:` address provided and no defaultFrom configured" },
  };
}

/** Mask the local-part of an email so logs don't leak addresses. */
function redactEmail(value: string): string {
  const [local, domain] = value.split("@");
  if (!local || !domain) return "<invalid>";
  const visible = local.length <= 2 ? local : `${local[0]}*${local[local.length - 1]}`;
  return `${visible}@${domain}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
