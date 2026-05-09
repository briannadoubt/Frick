import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { FrickClient, type SyncStatus } from "@frick/core";
import {
  foundationSchema,
  type FrickSchema,
  type PlainObject,
  type StreamEventInput,
} from "@frick/protocol";

const FrickContext = createContext<FrickClient | null>(null);

export interface FrickProviderProps {
  children: ReactNode;
  endpoint?: string;
  schema?: FrickSchema;
  client?: FrickClient;
}

export function FrickProvider({
  children,
  endpoint = "ws://127.0.0.1:4099/_frick/sync",
  schema = foundationSchema,
  client,
}: FrickProviderProps) {
  const frick = useMemo(
    () => client ?? new FrickClient({ endpoint, schema }),
    [client, endpoint, schema],
  );

  useEffect(() => {
    frick.connect();
    return () => frick.disconnect();
  }, [frick]);

  return <FrickContext.Provider value={frick}>{children}</FrickContext.Provider>;
}

export function useFrick(): FrickClient {
  const client = useContext(FrickContext);
  if (!client) {
    throw new Error("useFrick must be used inside <FrickProvider>");
  }
  return client;
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

export function useSyncStatus(): SyncStatus {
  const client = useFrick();
  return useSignalValue(client.syncStatus);
}

function useSignalValue<T>(signal: { value: T; subscribe(listener: (value: T) => void): () => void }): T {
  const [value, setValue] = useState(signal.value);
  useEffect(() => signal.subscribe(setValue), [signal]);
  return value;
}
