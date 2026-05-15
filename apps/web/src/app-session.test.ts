import { describe, expect, test } from "vitest";
import {
  authSessionStorageKey,
  clearStoredSession,
  clearStoredUserState,
  readStoredSession,
  writeStoredSession,
} from "./App.js";
import type { AuthSession } from "@frick/core/chat";

class MemoryStorage {
  readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const validSession: AuthSession = {
  sessionToken: "session-token-123",
  userId: "user-ada",
  deviceId: "device-web",
  replicaId: "replica-web",
  schemaHash: "schema-hash",
  expiresAt: "2026-05-09T13:00:00.000Z",
};

const pushRegistrationStorageKey = "frick-web-push-registration";

describe("stored auth sessions", () => {
  test("purges valid unexpired sessions from sessionStorage instead of restoring bearer tokens", () => {
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(authSessionStorageKey, JSON.stringify(validSession));

    expect(readStoredSession(sessionStorage, undefined, new Date("2026-05-09T12:00:00.000Z"))).toBeUndefined();
    expect(sessionStorage.getItem(authSessionStorageKey)).toBeNull();
  });

  test("clears expired sessions instead of restoring bearer tokens", () => {
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(authSessionStorageKey, JSON.stringify(validSession));

    expect(readStoredSession(sessionStorage, undefined, new Date("2026-05-09T14:00:00.000Z"))).toBeUndefined();
    expect(sessionStorage.getItem(authSessionStorageKey)).toBeNull();
  });

  test("clears malformed sessions instead of trusting expiresAt shape", () => {
    const sessionStorage = new MemoryStorage();
    sessionStorage.setItem(
      authSessionStorageKey,
      JSON.stringify({ ...validSession, expiresAt: "not-a-date" }),
    );

    expect(readStoredSession(sessionStorage, undefined, new Date("2026-05-09T12:00:00.000Z"))).toBeUndefined();
    expect(sessionStorage.getItem(authSessionStorageKey)).toBeNull();
  });

  test("purges valid legacy localStorage sessions instead of migrating bearer tokens", () => {
    const sessionStorage = new MemoryStorage();
    const localStorage = new MemoryStorage();
    localStorage.setItem(authSessionStorageKey, JSON.stringify(validSession));

    expect(readStoredSession(sessionStorage, localStorage, new Date("2026-05-09T12:00:00.000Z"))).toBeUndefined();
    expect(sessionStorage.getItem(authSessionStorageKey)).toBeNull();
    expect(localStorage.getItem(authSessionStorageKey)).toBeNull();
  });

  test("does not persist new bearer sessions and clears localStorage leftovers", () => {
    const sessionStorage = new MemoryStorage();
    const localStorage = new MemoryStorage();
    sessionStorage.setItem(authSessionStorageKey, JSON.stringify(validSession));
    localStorage.setItem(authSessionStorageKey, JSON.stringify(validSession));

    writeStoredSession(validSession, sessionStorage, localStorage);

    expect(sessionStorage.getItem(authSessionStorageKey)).toBeNull();
    expect(localStorage.getItem(authSessionStorageKey)).toBeNull();
  });

  test("storage helpers do not throw when browser storage is unavailable", () => {
    expect(readStoredSession(undefined, undefined, new Date("2026-05-09T12:00:00.000Z"))).toBeUndefined();
    expect(() => writeStoredSession(validSession, undefined, undefined)).not.toThrow();
    expect(() => clearStoredSession(undefined, undefined)).not.toThrow();
  });

  test("clears all browser-held user state on logout", () => {
    const sessionStorage = new MemoryStorage();
    const localStorage = new MemoryStorage();
    sessionStorage.setItem(authSessionStorageKey, JSON.stringify(validSession));
    localStorage.setItem(authSessionStorageKey, JSON.stringify(validSession));
    localStorage.setItem("frick.draft.user-ada.conversation-general", "secret draft");
    localStorage.setItem("frick.draft.user-grace.conversation-general", "other draft");
    localStorage.setItem(
      pushRegistrationStorageKey,
      JSON.stringify({
        registrationId: "push-1",
        deviceId: "device-web",
        token: "token",
        platform: "test",
        environment: "production",
        createdAt: "2026-05-09T12:00:00.000Z",
      }),
    );

    clearStoredUserState(sessionStorage, localStorage, "user-ada");

    expect(sessionStorage.getItem(authSessionStorageKey)).toBeNull();
    expect(localStorage.getItem(authSessionStorageKey)).toBeNull();
    expect(localStorage.getItem(pushRegistrationStorageKey)).toBeNull();
    expect(localStorage.getItem("frick.draft.user-ada.conversation-general")).toBeNull();
    expect(localStorage.getItem("frick.draft.user-grace.conversation-general")).toBe("other draft");
  });
});
