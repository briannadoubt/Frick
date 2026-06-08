import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  FrickClient,
  installBrowserAnalyticsTracking,
  acceptCall,
  callState,
  createCall,
  endCall,
  joinCall,
  leaveCall,
  setCallMediaState,
  type AnalyticsTrackOptions,
  type AnalyticsTrackReceipt,
  type BrowserAnalyticsTrackingOptions,
  type CallState,
  type CreateCallOptions,
  type CreateCallResult,
  type FrickSession,
  type JoinCallResult,
  type SyncStatus,
} from "@fricken/core";
import type {
  CallInviteRecord,
  CallMediaStatePatch,
  CallParticipantRecord,
  CallRoomRecord,
} from "@fricken/protocol";
import {
  foundationSchema,
  type FrickSchema,
  type PlainObject,
  type StreamEventInput,
} from "@fricken/protocol";

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
  autoAnalytics?: boolean | BrowserAnalyticsTrackingOptions;
}

export function FrickProvider({
  children,
  endpoint = "ws://127.0.0.1:4099/_frick/sync",
  httpEndpoint,
  schema = foundationSchema,
  client,
  session,
  autoAnalytics = true,
}: FrickProviderProps) {
  const resolvedHttpEndpoint = client?.httpEndpoint ?? httpEndpoint ?? resolveHttpEndpoint(endpoint);
  const frick = useMemo(
    () =>
      client ??
      new FrickClient({
        endpoint,
        httpEndpoint: resolvedHttpEndpoint,
        schema,
        ...(session !== undefined ? { session } : {}),
      }),
    [client, endpoint, resolvedHttpEndpoint, schema],
  );
  const value = useMemo(
    () => ({
      client: frick,
      httpEndpoint: resolvedHttpEndpoint,
      session: session === null ? undefined : session ?? frick.session,
    }),
    [frick, resolvedHttpEndpoint, session],
  );

  const status = useSignalValue(frick.syncStatus);
  const autoAnalyticsEnabled = autoAnalytics !== false;
  const autoAnalyticsOptions =
    autoAnalytics && autoAnalytics !== true ? autoAnalytics : undefined;
  const autoAnalyticsOptionsForInstall = useMemo(
    () => autoAnalyticsOptions,
    [
      autoAnalyticsOptions?.window,
      autoAnalyticsOptions?.trackInitialRoute,
      autoAnalyticsOptions?.trackHistoryChanges,
      autoAnalyticsOptions?.screenName,
      autoAnalyticsOptions?.routeProperties,
      autoAnalyticsOptions?.onError,
    ],
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

  const autoAnalyticsSessionToken = status.authenticated ? frick.sessionToken : undefined;
  useEffect(() => {
    if (!autoAnalyticsEnabled || !autoAnalyticsSessionToken) {
      return;
    }
    const tracker = installBrowserAnalyticsTracking(
      frick,
      autoAnalyticsOptionsForInstall,
    );
    return () => tracker.dispose();
  }, [autoAnalyticsEnabled, autoAnalyticsSessionToken, autoAnalyticsOptionsForInstall, frick]);

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

/**
 * Subscribe to a live stream and expose backwards-pagination affordances.
 *
 * Returns:
 *   - `events`: the current live tail (most recent at the end, server order).
 *   - `loadOlder(count?)`: HTTP-paginated scrollback; events are prepended
 *     to the live tail. Resolves with the number of events actually loaded
 *     (0 when there's nothing older).
 *   - `hasMore`: `true` until a `loadOlder` call returns fewer than the
 *     requested count, at which point we've reached the start.
 *   - `loading`: `true` while a `loadOlder` call is in flight.
 *
 * **Breaking shape change** vs the original `useStream`, which returned a
 * bare `T[]`. Pre-1.0 with `greenfield-cutover` compatibility makes the
 * one-shot bump safe; consumers migrate to destructured access.
 */
export function useStream<T extends StreamEventInput = StreamEventInput>(
  stream: string,
  key: string,
): {
  events: T[];
  loadOlder: (count?: number) => Promise<number>;
  hasMore: boolean;
  loading: boolean;
} {
  const client = useFrick();
  const signal = useMemo(() => client.stream(stream, key), [client, stream, key]);
  const liveTail = useSignalValue(signal) as T[];
  const [history, setHistory] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  // Reset history when the stream/key changes; otherwise stale history
  // bleeds across conversations.
  useEffect(() => {
    setHistory([]);
    setHasMore(true);
  }, [stream, key]);

  const loadOlder = useCallback(
    async (count = 50): Promise<number> => {
      setLoading(true);
      try {
        const oldestSequence = history.at(0)?.sequence ?? liveTail.at(0)?.sequence ?? Number.MAX_SAFE_INTEGER;
        const older = (await client.loadOlder(stream, key, count, oldestSequence)) as T[];
        if (older.length < count) setHasMore(false);
        if (older.length > 0) setHistory((prev) => [...older, ...prev]);
        return older.length;
      } finally {
        setLoading(false);
      }
    },
    [client, stream, key, history, liveTail],
  );

  const events = useMemo(() => [...history, ...liveTail], [history, liveTail]);
  return { events, loadOlder, hasMore, loading };
}

/**
 * Issue a typed append. Pass `options.optimistic` (a partial payload) to
 * surface the synthesized event in the matching `useStream` immediately,
 * before the server Ack. On Nack the overlay rolls back and the returned
 * Promise rejects with the typed error so the UI can recover.
 */
export function useAppend(
  stream: string,
  key: string,
): (
  event: string,
  payload: PlainObject,
  options?: { optimistic?: PlainObject },
) => Promise<void> {
  const client = useFrick();
  return useCallback(
    (event: string, payload: PlainObject, options?: { optimistic?: PlainObject }) =>
      client.append(stream, key, event, payload, options),
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

export function useTrackAnalyticsEvent(): (
  name: string,
  properties?: PlainObject,
  options?: Omit<AnalyticsTrackOptions, "properties">,
) => Promise<AnalyticsTrackReceipt> {
  const client = useFrick();
  return useCallback(
    (name: string, properties: PlainObject = {}, options: Omit<AnalyticsTrackOptions, "properties"> = {}) =>
      client.track(name, properties, options),
    [client],
  );
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

/**
 * Ergonomic wrapper over `FrickClient.upsertObject`. Returns a stable callback
 * that issues an object upsert over the sync socket. Conflict (when the schema
 * uses `versionPrecondition`) propagates as a `FrickObjectConflictError`.
 */
export function useUpsertObject<T extends PlainObject = PlainObject>(
  objectType: string,
): (
  objectId: string,
  value: T,
  expectedVersion?: number,
  options?: { optimistic?: boolean },
) => Promise<{ version: number }> {
  const client = useFrick();
  return useCallback(
    (objectId: string, value: T, expectedVersion?: number, options?: { optimistic?: boolean }) =>
      client.upsertObject<T>(objectType, objectId, value, expectedVersion, options),
    [client, objectType],
  );
}

export function useSyncStatus(): SyncStatus {
  const client = useFrick();
  return useSignalValue(client.syncStatus);
}

/**
 * FR-80 / FR-82 — reactive call state for `callId`. Composes the synced
 * `CallRoom` + `CallParticipant` records into a single {@link CallState} (room
 * snapshot + per-participant presence) that re-renders on every server delta
 * (join, mute, screen-share, leave, end). Subscribes the underlying object
 * types on mount and detaches on unmount.
 */
export function useCallState(callId: string): CallState {
  const client = useFrick();
  const { signal, dispose } = useMemo(() => callState(client, callId), [client, callId]);
  useEffect(() => dispose, [dispose]);
  return useSignalValue(signal);
}

/**
 * FR-80 — stable call control-plane action callbacks bound to the active
 * client. Each issues a server-authoritative command and resolves with the
 * server's typed result (or rejects on a control-plane Nack).
 */
export interface UseCallActions {
  createCall(options: CreateCallOptions): Promise<CreateCallResult>;
  joinCall(callId: string): Promise<JoinCallResult>;
  acceptCall(callId: string): Promise<CallInviteRecord>;
  leaveCall(callId: string): Promise<CallRoomRecord>;
  endCall(callId: string): Promise<CallRoomRecord>;
  setMediaState(callId: string, media: CallMediaStatePatch): Promise<CallParticipantRecord>;
}

export function useCallActions(): UseCallActions {
  const client = useFrick();
  return useMemo<UseCallActions>(
    () => ({
      createCall: (options) => createCall(client, options),
      joinCall: (callId) => joinCall(client, callId),
      acceptCall: (callId) => acceptCall(client, callId),
      leaveCall: (callId) => leaveCall(client, callId),
      endCall: (callId) => endCall(client, callId),
      setMediaState: (callId, media) => setCallMediaState(client, callId, media),
    }),
    [client],
  );
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
    setState((current) => ({ ...current, loading: true }));

    let url: URL;
    try {
      url = frickHttpUrl(httpEndpoint, path);
    } catch (error) {
      setState({
        data: undefined,
        error: error instanceof Error ? error : new Error("Endpoint request failed"),
        found: false,
        loading: false,
      });
      return () => controller.abort();
    }

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

export function frickHttpUrl(httpEndpoint: string, path: string): URL {
  const candidate = path.trim();
  if (candidate !== path || candidate.startsWith("//") || /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(candidate)) {
    throw new Error("Frick optional endpoint paths must be relative paths");
  }
  const base = new URL(`${httpEndpoint.replace(/\/$/, "")}/`);
  const url = new URL(candidate.replace(/^\/+/, ""), base);
  if (url.origin !== base.origin) {
    throw new Error("Frick optional endpoint paths must stay on the configured HTTP origin");
  }
  return url;
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
