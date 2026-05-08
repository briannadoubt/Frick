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
import { demoManifest, type FrickManifest, type PlainObject, type QuerySpec } from "@frick/protocol";

const FrickContext = createContext<FrickClient | null>(null);

export interface FrickProviderProps {
  children: ReactNode;
  endpoint?: string;
  manifest?: FrickManifest;
  client?: FrickClient;
}

export function FrickProvider({
  children,
  endpoint = "ws://127.0.0.1:4099/_frick/sync",
  manifest = demoManifest,
  client,
}: FrickProviderProps) {
  const frick = useMemo(
    () => client ?? new FrickClient({ endpoint, manifest }),
    [client, endpoint, manifest],
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

export function useQuery<T extends object = PlainObject>(spec: QuerySpec): T[] {
  const client = useFrick();
  const signal = useMemo(() => client.query(spec), [client, stableSpecKey(spec)]);
  const [value, setValue] = useState<T[]>(signal.value as T[]);

  useEffect(() => signal.subscribe((next) => setValue(next as T[])), [signal]);

  return value;
}

export function useMutation<TInput extends Record<string, unknown>>(
  name: string,
): (input: TInput) => Promise<void> {
  const client = useFrick();
  return useCallback((input: TInput) => client.mutate(name, input), [client, name]);
}

export function useSyncStatus(): SyncStatus {
  const client = useFrick();
  const [value, setValue] = useState(client.syncStatus.value);

  useEffect(() => client.syncStatus.subscribe(setValue), [client]);

  return value;
}

function stableSpecKey(spec: QuerySpec): string {
  return `${spec.entity}:${spec.index}:${JSON.stringify(spec.args, Object.keys(spec.args).sort())}`;
}
