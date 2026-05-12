/**
 * Message draft persistence.
 *
 * Stashes the active composer text per `(conversationId, userId)` in
 * `localStorage` (web) or the supplied `storage` adapter, debounced so
 * a fast typist doesn't hammer disk. Returns the draft + a setter that
 * acts like `useState` but persists every change.
 *
 * Lightweight v1: drafts live on the local device only. Cross-device
 * draft sync would mean adding a `MessageDraft` object to the foundation
 * schema, which bumps `schemaHash` and requires a native-artifact
 * regen pass — scoped to a follow-up rather than rolled into Phase 6.
 *
 * Returns `{ draft, setDraft, clear }`. The setter is fire-and-forget;
 * a brief crash window can lose the most recent keystrokes (no worse
 * than browser localStorage already is).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useFrickSession } from "./index.js";

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface UseDraftOptions {
  /** Override the underlying storage. Defaults to `globalThis.localStorage`. */
  readonly storage?: DraftStorage;
  /** Debounce window before persisting (ms). Defaults to 250ms. */
  readonly debounceMs?: number;
}

export function useDraft(
  conversationId: string,
  options: UseDraftOptions = {},
): { draft: string; setDraft: (value: string) => void; clear: () => void } {
  const session = useFrickSession();
  const userId = session?.userId ?? "anonymous";
  const storage = options.storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
  const key = `frick.draft.${userId}.${conversationId}`;
  const debounceMs = options.debounceMs ?? 250;

  // Hydrate once per (user, conversation). Re-runs when the conversation
  // changes so switching threads picks up the right draft instantly.
  const [draft, setDraftState] = useState<string>(() => {
    if (!storage) return "";
    try {
      return storage.getItem(key) ?? "";
    } catch {
      return "";
    }
  });

  useEffect(() => {
    if (!storage) return;
    try {
      setDraftState(storage.getItem(key) ?? "");
    } catch {
      setDraftState("");
    }
  }, [key, storage]);

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setDraft = useCallback(
    (value: string) => {
      setDraftState(value);
      if (!storage) return;
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        try {
          if (value.length === 0) storage.removeItem(key);
          else storage.setItem(key, value);
        } catch {
          // QuotaExceeded / Safari private mode — best-effort.
        }
      }, debounceMs);
    },
    [debounceMs, key, storage],
  );

  const clear = useCallback(() => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
    setDraftState("");
    if (!storage) return;
    try {
      storage.removeItem(key);
    } catch {
      // best-effort
    }
  }, [key, storage]);

  useEffect(() => () => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
  }, []);

  return { draft, setDraft, clear };
}
