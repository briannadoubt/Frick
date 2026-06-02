/**
 * Auth React surface.
 *
 * Wraps the HTTP auth helpers that graduated into `./chat-foundation.js`
 * (`devLogin`, `signUp`, `login`) into one-line hooks plus a
 * `<RequireAuth>` boundary component. The hooks own the local
 * mutable-session state via `FrickClient.setSession(...)`, so after a
 * successful sign-in the surrounding `<FrickProvider>` automatically sees
 * the new session and reconnects the WebSocket with the bearer token.
 *
 * Design intent: every consumer should be able to ship auth UI with
 * `useSignIn` / `useSignUp` / `useSignOut` and `<RequireAuth>` rather
 * than hand-rolling fetch + state. No 401 retry yet (the server doesn't
 * expose a refresh endpoint today — when it does, this is the place to
 * wire it).
 */

import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  devLogin as devLoginCore,
  login as loginCore,
  logout as logoutCore,
  signUp as signUpCore,
  type AuthSession,
} from "./chat-foundation.js";
import { useFrick, useFrickHttpEndpoint, useFrickSession } from "@fricken/react";

export function useSession(): AuthSession | undefined {
  // Re-uses the provider-tracked session. Cast: the runtime `FrickSession`
  // is a structural superset of the chat-layer `AuthSession`.
  return useFrickSession() as AuthSession | undefined;
}

interface SignInOptions {
  identity: string;
  password: string;
  deviceId?: string;
  replicaId?: string;
  platform?: string;
}

interface SignUpOptions {
  displayName: string;
  handle: string;
  password: string;
  deviceId?: string;
  replicaId?: string;
  platform?: string;
}

/**
 * `useSignIn()` returns a stable `signIn(opts)` function. Updates the
 * surrounding `<FrickProvider>` session on success.
 */
export function useSignIn(): {
  signIn: (opts: SignInOptions) => Promise<AuthSession>;
  isPending: boolean;
  error?: Error;
} {
  const client = useFrick();
  const httpEndpoint = useFrickHttpEndpoint();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const signIn = useCallback(
    async (opts: SignInOptions) => {
      setIsPending(true);
      setError(undefined);
      try {
        const session = await loginCore({ httpEndpoint, ...opts });
        client.setSession(session);
        return session;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        throw e;
      } finally {
        setIsPending(false);
      }
    },
    [client, httpEndpoint],
  );
  return error === undefined ? { signIn, isPending } : { signIn, isPending, error };
}

export function useSignUp(): {
  signUp: (opts: SignUpOptions) => Promise<AuthSession>;
  isPending: boolean;
  error?: Error;
} {
  const client = useFrick();
  const httpEndpoint = useFrickHttpEndpoint();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const signUp = useCallback(
    async (opts: SignUpOptions) => {
      setIsPending(true);
      setError(undefined);
      try {
        const session = await signUpCore({ httpEndpoint, ...opts });
        client.setSession(session);
        return session;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        throw e;
      } finally {
        setIsPending(false);
      }
    },
    [client, httpEndpoint],
  );
  return error === undefined ? { signUp, isPending } : { signUp, isPending, error };
}

/** Dev-mode quick-login shortcut. */
export function useDevSignIn(): (userId: string, opts?: { deviceId?: string; replicaId?: string; platform?: string }) => Promise<AuthSession> {
  const client = useFrick();
  const httpEndpoint = useFrickHttpEndpoint();
  return useCallback(
    async (userId, opts) => {
      const session = await devLoginCore({ httpEndpoint, userId, ...opts });
      client.setSession(session);
      return session;
    },
    [client, httpEndpoint],
  );
}

/**
 * Clear the session and local user-scoped runtime/cache state. The
 * client's WebSocket reconnects without a bearer token, which the server
 * treats as anonymous (most routes return 401).
 */
export function useSignOut(): () => void {
  const client = useFrick();
  const httpEndpoint = useFrickHttpEndpoint();
  const session = useFrickSession();
  return useCallback(() => {
    const token = session?.sessionToken;
    client.setSession(null);
    if (token) {
      void logoutCore({ httpEndpoint, sessionToken: token }).catch(() => {
        // Local sign-out should not depend on server reachability.
      });
    }
  }, [client, httpEndpoint, session?.sessionToken]);
}

/**
 * Render-gate: shows `children` when there's an authenticated session,
 * `fallback` otherwise. Pair with `useSignIn` / `useSignUp` inside the
 * fallback for a complete sign-in flow.
 */
export function RequireAuth({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const session = useSession();
  const isAuthed = useMemo(() => Boolean(session?.sessionToken), [session]);
  return <>{isAuthed ? children : fallback}</>;
}
