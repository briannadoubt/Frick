/**
 * Search hook backed by the server's `/search` endpoint.
 *
 * Debounces the input so a fast typist doesn't hammer the FTS index,
 * surfaces loading + error state, and threads the active session token
 * automatically. Returns a tagged `state` so callers can render skeleton
 * / error / results without nullable juggling.
 */

import { useEffect, useRef, useState } from "react";
import { searchMessages, type SearchResponse } from "@frick/core/chat";
import { useFrickHttpEndpoint, useFrickSession } from "./index.js";

export interface UseSearchOptions {
  readonly debounceMs?: number;
  readonly conversationId?: string;
  readonly limit?: number;
  /** When false, the hook is inert (no fetches). Useful for guarded UI. */
  readonly enabled?: boolean;
}

export interface UseSearchResult {
  readonly query: string;
  readonly response: SearchResponse | undefined;
  readonly isLoading: boolean;
  readonly error: Error | undefined;
}

const DEFAULT_DEBOUNCE_MS = 200;

export function useSearch(query: string, options: UseSearchOptions = {}): UseSearchResult {
  const httpEndpoint = useFrickHttpEndpoint();
  const session = useFrickSession();
  const [response, setResponse] = useState<SearchResponse | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  const lastQueryRef = useRef<string>("");

  const enabled = options.enabled ?? true;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  useEffect(() => {
    if (!enabled) {
      setResponse(undefined);
      setIsLoading(false);
      setError(undefined);
      return;
    }
    if (query.trim().length === 0) {
      setResponse(undefined);
      setIsLoading(false);
      setError(undefined);
      return;
    }
    lastQueryRef.current = query;
    let cancelled = false;
    setIsLoading(true);
    const handle = setTimeout(async () => {
      try {
        const result = await searchMessages({
          httpEndpoint,
          q: query,
          ...(options.conversationId ? { conversationId: options.conversationId } : {}),
          limit: options.limit ?? 50,
          sessionToken: session?.sessionToken,
        });
        if (cancelled || lastQueryRef.current !== query) return;
        setResponse(result);
        setError(undefined);
      } catch (err) {
        if (cancelled || lastQueryRef.current !== query) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setResponse(undefined);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [enabled, query, debounceMs, options.conversationId, options.limit, httpEndpoint, session]);

  return { query, response, isLoading, error };
}
