/**
 * Message draft persistence.
 *
 * Two backends, picked at call time via `options.sync`:
 *
 * 1. **Local** (default): stashes the active composer text per
 *    `(conversationId, userId)` in `localStorage` (web) or the supplied
 *    `storage` adapter, debounced so a fast typist doesn't hammer disk.
 *    Drafts live on the local device only.
 * 2. **Synced** (`sync: true`): upserts a `MessageDraft` foundation
 *    object on every change. Every device authenticated as the same
 *    user sees the latest body. Conflicts (concurrent typing on two
 *    devices) surface as `FrickObjectConflictError` and default to
 *    last-write-wins.
 *
 * Returns `{ draft, setDraft, clear }`. The setter is fire-and-forget;
 * a brief crash window can lose the most recent keystrokes (no worse
 * than browser localStorage already is).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlainObject } from "@frick/protocol";
import { FrickObjectConflictError } from "@frick/core";
import { useFrick, useFrickSession, useObject } from "./index.js";

/** Stable id convention used by all SDKs for `MessageDraft` rows. */
export function draftId(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`;
}

interface MessageDraftRow extends PlainObject {
  userId: string;
  conversationId: string;
  body: string;
  updatedAt: number;
}

/**
 * Upsert a `MessageDraft` row, retrying once on a `versionPrecondition`
 * conflict by re-issuing the write at the server-reported version
 * (last-write-wins). Exposed for testability and reused by the synced
 * `useDraft` path below.
 */
export async function upsertDraftWithLwwRetry(
  client: { upsertObject<T extends PlainObject>(
    type: string,
    id: string,
    value: T,
    expectedVersion: number | undefined,
    options: { optimistic: boolean },
  ): Promise<{ version: number }> },
  id: string,
  row: MessageDraftRow,
  expectedVersion: number | undefined,
): Promise<{ version: number }> {
  try {
    return await client.upsertObject<MessageDraftRow>(
      "MessageDraft",
      id,
      row,
      expectedVersion,
      { optimistic: true },
    );
  } catch (error) {
    if (error instanceof FrickObjectConflictError) {
      return client.upsertObject<MessageDraftRow>(
        "MessageDraft",
        id,
        row,
        error.actualVersion,
        { optimistic: true },
      );
    }
    throw error;
  }
}

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
  /**
   * When `true`, persist the draft as a `MessageDraft` foundation
   * object so every device sees it. Defaults to `false` (local-only).
   */
  readonly sync?: boolean;
}

export function useDraft(
  conversationId: string,
  options: UseDraftOptions = {},
): { draft: string; setDraft: (value: string) => void; clear: () => void } {
  const session = useFrickSession();
  const userId = session?.userId ?? "anonymous";
  // `options.sync` is treated as a stable mode flag — pick the
  // implementation at first render and stick with it. Switching it at
  // runtime would break the rules of hooks (different hook calls per
  // render), so consumers should pass a stable value.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  if (options.sync) return useSyncedDraft(userId, conversationId, options.debounceMs ?? 250);
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

/**
 * Cross-device draft path. Reads via `useObject<MessageDraft>` (subscription
 * is established by the client when the type is first observed) and writes
 * via debounced `client.upsertObject` with `optimistic: true` so the
 * local UI is responsive even when the socket round-trip is slow.
 */
function useSyncedDraft(
  userId: string,
  conversationId: string,
  debounceMs: number,
): { draft: string; setDraft: (value: string) => void; clear: () => void } {
  const client = useFrick();
  const id = useMemo(() => draftId(userId, conversationId), [userId, conversationId]);
  const remote = useObject<MessageDraftRow>("MessageDraft", id);
  // Track the last server-confirmed version so the next upsert sends
  // it as `expectedVersion`. `undefined` for create-intent attempts.
  const versionRef = useRef<number | undefined>(undefined);
  const [draft, setDraftState] = useState<string>(remote?.body ?? "");
  // Echo-suppression: ignore a remote row whose `body` matches the
  // value we most recently set locally — that's just our own write
  // round-tripping back.
  const lastWroteRef = useRef<string | null>(null);

  useEffect(() => {
    if (!remote) return;
    const incoming = remote.body ?? "";
    if (lastWroteRef.current !== null && lastWroteRef.current === incoming) {
      return;
    }
    setDraftState(incoming);
  }, [remote?.body]); // eslint-disable-line react-hooks/exhaustive-deps

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(
    async (value: string) => {
      lastWroteRef.current = value;
      const payload: MessageDraftRow = {
        userId,
        conversationId,
        body: value,
        updatedAt: Date.now(),
      };
      try {
        const result = await upsertDraftWithLwwRetry(client, id, payload, versionRef.current);
        versionRef.current = result.version;
      } catch {
        // best-effort: a second conflict (or transport error) will be
        // picked up by the next keystroke's debounce.
      }
    },
    [client, id, userId, conversationId],
  );

  const setDraft = useCallback(
    (value: string) => {
      setDraftState(value);
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        void flush(value);
      }, debounceMs);
    },
    [debounceMs, flush],
  );

  const clear = useCallback(() => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
    setDraftState("");
    void flush("");
  }, [flush]);

  useEffect(() => () => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
  }, []);

  return { draft, setDraft, clear };
}
