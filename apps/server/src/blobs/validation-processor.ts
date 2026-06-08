/**
 * Generic MIME/size validation + moderation-hook processors (FR-55).
 *
 * The stock {@link imageBlobProcessor} (FR-130) covers image uploads, but apps
 * routinely accept other content (PDFs, audio, arbitrary documents) and want a
 * declarative allow-list gate without hand-writing a `validate` hook. This
 * ships two additive, registry-friendly factories:
 *
 *   - {@link mimeSizeValidator} — a {@link FrickBlobProcessor} whose `validate`
 *     hook rejects empty uploads, uploads above a configurable byte cap, and
 *     MIME types outside a configurable allow-list, with a clear rejection
 *     reason. Allow-list entries match either exactly (`application/pdf`) or by
 *     prefix when they end in `/` (`image/`).
 *
 *   - {@link moderationProcessor} — the *hook mechanism* for content
 *     moderation. It wraps an app-supplied async {@link BlobModerationHook}
 *     into the async `process` phase so moderation decisions never block the
 *     upload request. The framework ships the plumbing only; the actual
 *     moderation call (a vendor API, an ML model, a manual queue) is the app's.
 *
 * Both are tightly scoped and behind the existing processor surface — register
 * them via `blobProcessors` at boot like any other processor.
 */
import type {
  FrickBlobProcessContext,
  FrickBlobProcessor,
  FrickBlobProcessResult,
  FrickBlobValidationResult,
} from "./processor.js";

export interface MimeSizeValidatorOptions {
  /** Processor id. Defaults to `"frick-mime-size"`. */
  id?: string;
  /**
   * Allowed MIME types. An entry ending in `/` matches by prefix
   * (`"image/"` ⇒ `image/png`); any other entry matches exactly. When omitted
   * or empty, every MIME type is allowed (size-only gate).
   */
  allowedMimeTypes?: string[];
  /** Hard upper bound on upload size in bytes. Undefined ⇒ no size cap. */
  maxBytes?: number;
  /**
   * Reject zero-byte uploads. Defaults to `true` — an empty blob is almost
   * always a client bug worth surfacing early.
   */
  rejectEmpty?: boolean;
  /**
   * Match criteria deciding which uploads this processor inspects. Defaults to
   * `{}` (every upload), so disallowed content is actively rejected rather than
   * silently skipped.
   */
  matches?: FrickBlobProcessor["matches"];
}

const DEFAULT_VALIDATOR_ID = "frick-mime-size";

function mimeAllowed(mimeType: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  return allowed.some((entry) =>
    entry.endsWith("/") ? mimeType.startsWith(entry) : mimeType === entry,
  );
}

/**
 * Build a {@link FrickBlobProcessor} that gates uploads on MIME allow-list and
 * size, rejecting disallowed uploads with a clear reason before any row is
 * written. Reuses the registry pattern — register it alongside other
 * processors via the server's `blobProcessors` option.
 */
export function mimeSizeValidator(
  options: MimeSizeValidatorOptions = {},
): FrickBlobProcessor {
  const id = options.id ?? DEFAULT_VALIDATOR_ID;
  const allowed = options.allowedMimeTypes ?? [];
  const maxBytes = options.maxBytes;
  const rejectEmpty = options.rejectEmpty ?? true;
  const matches = options.matches ?? {};

  return {
    id,
    matches,
    async validate(ctx): Promise<FrickBlobValidationResult> {
      if (rejectEmpty && ctx.byteLength === 0) {
        return { ok: false, reason: "Empty upload." };
      }
      if (typeof maxBytes === "number" && ctx.byteLength > maxBytes) {
        return {
          ok: false,
          reason: `Upload is ${ctx.byteLength} bytes; the limit is ${maxBytes}.`,
        };
      }
      if (!mimeAllowed(ctx.mimeType, allowed)) {
        return {
          ok: false,
          reason: `MIME type "${ctx.mimeType}" is not allowed.`,
        };
      }
      return { ok: true };
    },
  };
}

/** Verdict returned by a {@link BlobModerationHook}. */
export interface BlobModerationVerdict {
  /** Coarse classification of the content. */
  decision: "allow" | "flag" | "reject";
  /** Optional human-readable rationale, persisted on the sidecar derivative. */
  reason?: string;
  /** Optional structured detail (vendor scores, label spans, etc.). */
  details?: Record<string, unknown>;
}

/** Context handed to a {@link BlobModerationHook}. */
export interface BlobModerationContext {
  tenantId: string;
  blobId: string;
  ownerId: string;
  mimeType: string;
  byteLength: number;
  /** Full stored bytes of the blob, or undefined if content is missing. */
  content: Buffer | undefined;
}

/**
 * App-supplied moderation decision function. Frick ships the hook *mechanism*,
 * not an implementation — apps plug in a vendor API, an ML model, or a manual
 * review queue here. Throwing makes the `blob.process` job retry.
 */
export type BlobModerationHook = (
  ctx: BlobModerationContext,
) => Promise<BlobModerationVerdict> | BlobModerationVerdict;

export interface ModerationProcessorOptions {
  /** Processor id. Defaults to `"frick-moderation"`. */
  id?: string;
  /** The app's moderation decision function. */
  hook: BlobModerationHook;
  /**
   * Derivative id under which the moderation verdict sidecar is persisted.
   * Defaults to `"moderation"`. The sidecar is a small JSON blob recording the
   * decision so downstream code can gate access on it.
   */
  derivativeId?: string;
  /** Match criteria. Defaults to `{}` (moderate every upload). */
  matches?: FrickBlobProcessor["matches"];
}

const DEFAULT_MODERATION_ID = "frick-moderation";

/**
 * Build a {@link FrickBlobProcessor} that runs an app moderation hook in the
 * async `process` phase and persists the verdict as a JSON sidecar derivative.
 * This is the extension point referenced by FR-55: ship the wiring, let apps
 * own the policy.
 */
export function moderationProcessor(
  options: ModerationProcessorOptions,
): FrickBlobProcessor {
  const id = options.id ?? DEFAULT_MODERATION_ID;
  const derivativeId = options.derivativeId ?? "moderation";
  const matches = options.matches ?? {};
  const { hook } = options;

  return {
    id,
    matches,
    async process(ctx: FrickBlobProcessContext): Promise<FrickBlobProcessResult> {
      const raw = await ctx.store.blobs.readContent(ctx.tenantId, ctx.blobId);
      const content = raw ? Buffer.from(raw) : undefined;
      const verdict = await hook({
        tenantId: ctx.tenantId,
        blobId: ctx.blobId,
        ownerId: ctx.ownerId,
        mimeType: ctx.mimeType,
        byteLength: ctx.byteLength,
        content,
      });
      ctx.logger.info("frick.blob.moderated", {
        event: "frick.blob.moderated",
        blobId: ctx.blobId,
        processorId: id,
        decision: verdict.decision,
      });
      const sidecar = JSON.stringify(verdict);
      return {
        derivatives: [
          {
            derivativeId,
            mimeType: "application/json",
            bytes: Buffer.from(sidecar, "utf8"),
            metadata: {
              decision: verdict.decision,
              ...(verdict.reason ? { reason: verdict.reason } : {}),
            },
          },
        ],
      };
    },
  };
}
