import { describe, expect, it } from "vitest";
import {
  ErrorLocalizer,
  FRICK_ERROR_CODES,
  defaultErrorMessages,
  defaultMessagesCoverAllCodes,
  localizeErrorCode,
  type FrickErrorEnvelope,
  type FrickMessageTable,
} from "../src/index.js";

describe("error-code localization", () => {
  it("maps every canonical error code to an English default", () => {
    expect(defaultMessagesCoverAllCodes()).toBe(true);
    for (const code of FRICK_ERROR_CODES) {
      expect(defaultErrorMessages[code]).toBeDefined();
    }
  });

  it("resolves the default English message for a code", () => {
    const loc = new ErrorLocalizer();
    expect(loc.localize("storage.conflict")).toBe(defaultErrorMessages["storage.conflict"]);
  });

  it("uses an app-supplied locale table when present", () => {
    const es: FrickMessageTable = {
      "auth.unauthenticated": "Debes iniciar sesión para continuar.",
    };
    const loc = new ErrorLocalizer({ locales: { es }, locale: "es" });
    expect(loc.localize("auth.unauthenticated")).toBe("Debes iniciar sesión para continuar.");
  });

  it("falls back to English for codes the locale table omits", () => {
    const es: FrickMessageTable = { "auth.unauthenticated": "Debes iniciar sesión." };
    const loc = new ErrorLocalizer({ locales: { es }, locale: "es" });
    // Not in the Spanish table -> English default.
    expect(loc.localize("storage.notFound")).toBe(defaultErrorMessages["storage.notFound"]);
  });

  it("falls back from a region tag to the base language", () => {
    const fr: FrickMessageTable = { "blob.tooLarge": "Fichier trop volumineux." };
    const loc = new ErrorLocalizer({ locales: { fr }, locale: "fr-CA" });
    expect(loc.localize("blob.tooLarge")).toBe("Fichier trop volumineux.");
  });

  it("interpolates {token} placeholders from envelope details", () => {
    const en: FrickMessageTable = { "blob.tooLarge": "Too large (max {limit} bytes)." };
    const loc = new ErrorLocalizer({ locales: { en }, locale: "en" });
    const envelope: FrickErrorEnvelope = {
      code: "blob.tooLarge",
      message: "File too large",
      requestId: "req-1",
      retryable: false,
      details: { limit: 1024 },
    };
    expect(loc.localize(envelope)).toBe("Too large (max 1024 bytes).");
  });

  it("supports function messages for non-template grammar", () => {
    const en: FrickMessageTable = {
      "rateLimit.exceeded": (p) => `Slow down (retry in ${p.retryAfter}s).`,
    };
    const loc = new ErrorLocalizer({ locales: { en }, locale: "en" });
    expect(loc.localize("rateLimit.exceeded", { retryAfter: 5 })).toBe("Slow down (retry in 5s).");
  });

  it("leaves unknown tokens intact rather than dropping them", () => {
    const en: FrickMessageTable = { "server.internal": "Ref {requestId} / {missing}." };
    const loc = new ErrorLocalizer({ locales: { en }, locale: "en" });
    const envelope: FrickErrorEnvelope = {
      code: "server.internal",
      message: "boom",
      requestId: "req-9",
      retryable: true,
    };
    expect(loc.localize(envelope)).toBe("Ref req-9 / {missing}.");
  });

  it("setLocale switches the active table", () => {
    const loc = new ErrorLocalizer({
      locales: { es: { "auth.forbidden": "No tienes permiso." } },
    });
    expect(loc.localize("auth.forbidden")).toBe(defaultErrorMessages["auth.forbidden"]);
    loc.setLocale("es");
    expect(loc.getLocale()).toBe("es");
    expect(loc.localize("auth.forbidden")).toBe("No tienes permiso.");
  });

  it("localizeErrorCode is a one-shot convenience over a localizer", () => {
    expect(localizeErrorCode("storage.conflict")).toBe(defaultErrorMessages["storage.conflict"]);
    expect(
      localizeErrorCode("auth.forbidden", { locales: { es: { "auth.forbidden": "Prohibido." } }, locale: "es" }),
    ).toBe("Prohibido.");
  });
});
