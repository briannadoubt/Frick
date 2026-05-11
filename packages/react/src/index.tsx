import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { FrickClient, type FrickSession, type SyncStatus } from "@frick/core";
import {
  foundationSchema,
  type FrickSchema,
  type PlainObject,
  type StreamEventInput,
} from "@frick/protocol";

interface FrickContextValue {
  client: FrickClient;
  httpEndpoint: string;
  session: FrickSession | undefined;
}

const FrickContext = createContext<FrickContextValue | null>(null);

export interface FrickProviderProps {
  children: ReactNode;
  endpoint?: string;
  httpEndpoint?: string;
  schema?: FrickSchema;
  client?: FrickClient;
  session?: FrickSession | null | undefined;
}

export function FrickProvider({
  children,
  endpoint = "ws://127.0.0.1:4099/_frick/sync",
  httpEndpoint,
  schema = foundationSchema,
  client,
  session,
}: FrickProviderProps) {
  const frick = useMemo(
    () => client ?? new FrickClient({ endpoint, schema, ...(session !== undefined ? { session } : {}) }),
    [client, endpoint, schema],
  );
  const value = useMemo(
    () => ({
      client: frick,
      httpEndpoint: httpEndpoint ?? resolveHttpEndpoint(endpoint),
      session: session === null ? undefined : session ?? frick.session,
    }),
    [frick, endpoint, httpEndpoint, session],
  );

  useEffect(() => {
    if (session !== undefined) {
      frick.setSession(session);
    }
  }, [frick, session]);

  useEffect(() => {
    frick.connect();
    return () => frick.disconnect();
  }, [frick]);

  return <FrickContext.Provider value={value}>{children}</FrickContext.Provider>;
}

export function useFrick(): FrickClient {
  const context = useContext(FrickContext);
  if (!context) {
    throw new Error("useFrick must be used inside <FrickProvider>");
  }
  return context.client;
}

export function useFrickHttpEndpoint(): string {
  const context = useContext(FrickContext);
  if (!context) {
    throw new Error("useFrickHttpEndpoint must be used inside <FrickProvider>");
  }
  return context.httpEndpoint;
}

export function useFrickSession(): FrickSession | undefined {
  const context = useContext(FrickContext);
  if (!context) {
    throw new Error("useFrickSession must be used inside <FrickProvider>");
  }
  return context.session;
}

export function useAuthorizedFetchInit(): (init?: RequestInit) => RequestInit {
  const session = useFrickSession();
  return useCallback((init?: RequestInit) => createAuthorizedFetchInit(session, init), [session]);
}

export function useObject<T extends PlainObject = PlainObject>(type: string, id: string): T | undefined {
  return useObjects<T>(type).find((object) => object.id === id);
}

export function useObjects<T extends PlainObject = PlainObject>(type: string): T[] {
  const client = useFrick();
  const signal = useMemo(() => client.objects(type), [client, type]);
  return useSignalValue(signal) as T[];
}

export function useStream<T extends StreamEventInput = StreamEventInput>(stream: string, key: string): T[] {
  const client = useFrick();
  const signal = useMemo(() => client.stream(stream, key), [client, stream, key]);
  return useSignalValue(signal) as T[];
}

export function useAppend(
  stream: string,
  key: string,
): (event: string, payload: PlainObject) => Promise<void> {
  const client = useFrick();
  return useCallback(
    (event: string, payload: PlainObject) => client.append(stream, key, event, payload),
    [client, stream, key],
  );
}

export function usePresence<T extends PlainObject = PlainObject>(
  name: string,
  key: string,
): T | undefined {
  const client = useFrick();
  const signal = useMemo(() => client.presence(name, key), [client, name, key]);
  return useSignalValue(signal) as T | undefined;
}

export function useSetPresence(
  name: string,
  key: string,
): (value: PlainObject) => Promise<void> {
  const client = useFrick();
  return useCallback((value: PlainObject) => client.setPresence(name, key, value), [client, name, key]);
}

export function useSignalChannel<T extends PlainObject = PlainObject>(name: string, key: string): T[] {
  const client = useFrick();
  const signal = useMemo(() => client.signalChannel(name, key), [client, name, key]);
  return useSignalValue(signal) as T[];
}

export function useSendSignal(
  name: string,
  key: string,
): (value: PlainObject) => Promise<void> {
  const client = useFrick();
  return useCallback((value: PlainObject) => client.sendSignal(name, key, value), [client, name, key]);
}

/**
 * Subscribe to a server-side projection by name. Returns a Map keyed by the
 * projection's row key. Updates arrive via ProjectionDelta frames; `null`
 * values delete the corresponding key.
 */
export function useProjection<T extends PlainObject = PlainObject>(
  name: string,
): Map<string, T> {
  const client = useFrick();
  const signal = useMemo(() => client.projection<T>(name), [client, name]);
  return useSignalValue(signal);
}

/** Convenience wrapper returning the projection rows as an array. */
export function useProjectionRows<T extends PlainObject = PlainObject>(name: string): T[] {
  const rows = useProjection<T>(name);
  return useMemo(() => Array.from(rows.values()), [rows]);
}

export function useSyncStatus(): SyncStatus {
  const client = useFrick();
  return useSignalValue(client.syncStatus);
}

export interface OptionalEndpointState<T> {
  data: T | undefined;
  error: Error | undefined;
  found: boolean;
  loading: boolean;
  refetch(): void;
}

export function useOptionalEndpoint<T = unknown>(path: string): OptionalEndpointState<T> {
  const client = useFrick();
  const httpEndpoint = useFrickHttpEndpoint();
  const session = useFrickSession();
  const status = useSignalValue(client.syncStatus);
  const cursorToken = cursorFingerprint(status.cursors);
  const sessionToken = session?.sessionToken;
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<Omit<OptionalEndpointState<T>, "refetch">>({
    data: undefined,
    error: undefined,
    found: false,
    loading: true,
  });

  useEffect(() => {
    const controller = new AbortController();
    const url = new URL(path, `${httpEndpoint.replace(/\/$/, "")}/`);
    setState((current) => ({ ...current, loading: true }));

    fetch(url, createAuthorizedFetchInit(session, { signal: controller.signal }))
      .then(async (response) => {
        if (response.status === 404) {
          setState({ data: undefined, error: undefined, found: false, loading: false });
          return;
        }
        if (!response.ok) {
          throw new Error(`Endpoint ${url.pathname} returned ${response.status}`);
        }
        const body = (await response.json()) as T;
        setState({ data: body, error: undefined, found: true, loading: false });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setState({
          data: undefined,
          error: error instanceof Error ? error : new Error("Endpoint request failed"),
          found: false,
          loading: false,
        });
      });

    return () => controller.abort();
  }, [cursorToken, httpEndpoint, path, session, sessionToken, version]);

  const refetch = useCallback(() => setVersion((current) => current + 1), []);
  return { ...state, refetch };
}

export type InboxEndpointData<T extends PlainObject = PlainObject> = T[] | { data: T[] };

export function useInbox<T extends PlainObject = PlainObject>(
  userId?: string,
): OptionalEndpointState<InboxEndpointData<T>> {
  return useOptionalEndpoint<InboxEndpointData<T>>(inboxEndpointPath(userId));
}

export function inboxEndpointPath(userId?: string): string {
  if (!userId) {
    return "/inbox";
  }
  const query = new URLSearchParams({ userId });
  return `/inbox?${query.toString()}`;
}

export function resolveHttpEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
    url.pathname = "";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
    url.pathname = "";
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function createAuthorizedFetchInit(
  session: Partial<FrickSession> | null | undefined,
  init: RequestInit = {},
): RequestInit {
  if (!session?.sessionToken) {
    return init;
  }
  return {
    ...init,
    headers: {
      ...headersRecord(init.headers),
      Authorization: `Bearer ${session.sessionToken}`,
    },
  };
}

function useSignalValue<T>(signal: { value: T; subscribe(listener: (value: T) => void): () => void }): T {
  const [value, setValue] = useState(signal.value);
  useEffect(() => signal.subscribe(setValue), [signal]);
  return value;
}

function cursorFingerprint(cursors: Record<string, number>): string {
  return Object.entries(cursors)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join("|");
}

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}
