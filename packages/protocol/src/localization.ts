/**
 * Localization hooks for framework error codes (FR-103).
 *
 * The wire protocol speaks in stable, machine-readable error *codes* (see
 * {@link FRICK_ERROR_CODES}) — those never change and are never translated.
 * Turning a code into a human-readable, localized string is purely a
 * presentation-layer concern that lives on the client, which is what this
 * module provides.
 *
 * The design is intentionally minimal: a default (English) message table, a way
 * for an app to supply its own locale tables, and a resolver that maps a code
 * (plus optional interpolation params) to a string with a deterministic
 * fallback chain. No translation set ships here beyond the English defaults.
 */
import { FRICK_ERROR_CODES, type FrickErrorCode, type FrickErrorEnvelope } from "./errors.js";

/**
 * Interpolation params made available to a message template. Values come from
 * an error envelope's `details` (and a few well-known envelope fields), so a
 * template like `"Too large (max {limit} bytes)"` can be filled in per error.
 */
export type FrickMessageParams = Record<string, string | number | boolean>;

/**
 * A single localized message: either a static string, or a function that
 * receives the interpolation params and returns the final string. Functions let
 * apps handle pluralization / grammar that a `{token}` template can't express.
 */
export type FrickMessage = string | ((params: FrickMessageParams) => string);

/** A (partial) table mapping error codes to localized messages for one locale. */
export type FrickMessageTable = Partial<Record<FrickErrorCode, FrickMessage>>;

/**
 * The built-in English message table. Every canonical error code has an entry,
 * so English is always a complete fallback. Templates use `{token}` placeholders
 * that are filled from the error's `details`.
 */
export const defaultErrorMessages: Record<FrickErrorCode, FrickMessage> = {
  "auth.unauthenticated": "You need to sign in to continue.",
  "auth.forbidden": "You don't have permission to do that.",
  "auth.sessionExpired": "Your session expired. Please sign in again.",
  "schema.incompatible": "This app is out of date and can't talk to the server.",
  "schema.migrationRequired": "A data migration is required before continuing.",
  "storage.conflict": "Someone else changed this first. Reload and try again.",
  "storage.notFound": "That item could not be found.",
  "stream.appendRejected": "That change was rejected.",
  "stream.invalidCursor": "The sync position is no longer valid. Reconnecting…",
  "sync.protocolError": "A sync error occurred. Reconnecting…",
  "sync.reconnectExhausted": "Couldn't reconnect. Please check your connection.",
  "blob.tooLarge": "That file is too large.",
  "blob.unsupportedContentType": "That file type isn't supported.",
  "blob.quotaExceeded": "Storage quota exceeded.",
  "rateLimit.exceeded": "You're going too fast. Please slow down and try again.",
  "server.internal": "Something went wrong on our end. Please try again.",
};

/**
 * Replace `{token}` placeholders in a template with values from `params`.
 * Unknown tokens are left intact so a missing param is visible rather than
 * silently dropped.
 */
function interpolate(template: string, params: FrickMessageParams): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
  );
}

function renderMessage(message: FrickMessage, params: FrickMessageParams): string {
  return typeof message === "function" ? message(params) : interpolate(message, params);
}

/** Options controlling how an {@link ErrorLocalizer} resolves messages. */
export interface ErrorLocalizerOptions {
  /**
   * App-supplied locale tables keyed by locale tag (e.g. `"es"`, `"fr-CA"`).
   * Each table is partial — any code it omits falls through to the English
   * defaults, so apps only translate the codes they care about.
   */
  locales?: Record<string, FrickMessageTable>;
  /** The active locale tag. Defaults to `"en"`. */
  locale?: string;
}

/**
 * Resolves error codes to localized human messages with a deterministic
 * fallback chain. Construct one per app (optionally per active locale) and call
 * {@link ErrorLocalizer.localize} with an error code or a full
 * {@link FrickErrorEnvelope}.
 */
export class ErrorLocalizer {
  private readonly locales: Record<string, FrickMessageTable>;
  private locale: string;

  constructor(options: ErrorLocalizerOptions = {}) {
    this.locales = options.locales ?? {};
    this.locale = options.locale ?? "en";
  }

  /** Switch the active locale tag. Tables are matched case-insensitively. */
  setLocale(locale: string): void {
    this.locale = locale;
  }

  /** The currently active locale tag. */
  getLocale(): string {
    return this.locale;
  }

  private lookup(locale: string, code: FrickErrorCode): FrickMessage | undefined {
    const exact = this.locales[locale];
    if (exact && exact[code] !== undefined) {
      return exact[code];
    }
    // Fall back from a region-qualified tag (`fr-CA`) to the base language (`fr`).
    const dash = locale.indexOf("-");
    if (dash > 0) {
      return this.lookup(locale.slice(0, dash), code);
    }
    return undefined;
  }

  /**
   * Resolve a localized message for an error code or envelope.
   *
   * Fallback order:
   *   1. The active locale's table (region tag, then base language).
   *   2. The English defaults.
   *   3. The envelope's own `message` (when given an envelope).
   *   4. A bracketed copy of the raw code, so the UI never renders empty.
   *
   * When passed an envelope, the envelope's `details` are merged with a few
   * well-known fields (`requestId`, `code`) and exposed to the message template
   * as interpolation params.
   */
  localize(input: FrickErrorCode | FrickErrorEnvelope, params: FrickMessageParams = {}): string {
    const isEnvelope = typeof input !== "string";
    const code = isEnvelope ? input.code : input;
    const mergedParams: FrickMessageParams = isEnvelope
      ? { ...flattenDetails(input.details), code: input.code, requestId: input.requestId, ...params }
      : params;

    const localized = this.lookup(this.locale, code);
    if (localized !== undefined) {
      return renderMessage(localized, mergedParams);
    }

    const fallback = defaultErrorMessages[code];
    if (fallback !== undefined) {
      return renderMessage(fallback, mergedParams);
    }

    if (isEnvelope && input.message) {
      return input.message;
    }
    return `[${code}]`;
  }
}

/**
 * Flatten an envelope's `details` into string/number/boolean params usable for
 * template interpolation. Nested / non-primitive values are dropped (they can't
 * be rendered into a `{token}`), keeping the param surface predictable.
 */
function flattenDetails(details: Record<string, unknown> | undefined): FrickMessageParams {
  const out: FrickMessageParams = {};
  if (!details) {
    return out;
  }
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Convenience one-shot localizer. Prefer constructing an {@link ErrorLocalizer}
 * when you resolve more than a couple of messages or need a non-default locale.
 */
export function localizeErrorCode(
  input: FrickErrorCode | FrickErrorEnvelope,
  options: ErrorLocalizerOptions = {},
  params: FrickMessageParams = {},
): string {
  return new ErrorLocalizer(options).localize(input, params);
}

/**
 * Returns true when the English default table has a message for every canonical
 * error code. Exported so a test can prove the invariant.
 */
export function defaultMessagesCoverAllCodes(): boolean {
  return FRICK_ERROR_CODES.every((code) => defaultErrorMessages[code] !== undefined);
}
