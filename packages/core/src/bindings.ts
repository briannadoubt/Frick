/**
 * Schema-bound client surface.
 *
 * `bindSchema(client, schema)` returns an object keyed by every object /
 * stream / presence / signal / projection in the schema, each property
 * exposing reactive accessors and mutation helpers wired to the underlying
 * {@link FrickClient}. The result is the runtime backing for the typed
 * `FrickBindings` interface emitted by
 * `packages/protocol/src/generators/typescript.ts`.
 *
 * The bindings here are **untyped at the value level** — they accept and
 * return `PlainObject`. The generated artifact in
 * `packages/core/src/generated/bindings.ts` exports a typed
 * `bindFrickSchema(client)` that casts the return type of this factory to
 * the schema-derived interface. This split lets us evolve the runtime
 * implementation without regenerating, and lets the generator stay a pure
 * `FrickSchema → string` transform.
 *
 * Design intent: every reactive accessor reuses the existing `FrickClient`
 * Signal cache so subscribing to the same `(type, id)` twice returns the
 * same signal, and a single Delta updates every subscriber. Mutation
 * helpers thread through `client.append` / `client.upsertObject` /
 * `client.sendSignal` / `client.setPresence` / `client.clearPresence` so
 * the existing pending-write queue and ack/nack bookkeeping work
 * unchanged.
 */

import type { FrickSchema, PlainObject, StreamEventInput } from "@frick/protocol";
import type { FrickClient } from "./runtime.js";
import type { Signal } from "./subscriptions.js";

/**
 * Reactive + mutating surface for a single object type.
 *
 * `useAll` returns the list signal. `useOne` resolves a single row from
 * the cached list (re-running on every list change — small data set
 * assumption). `upsert` forwards to {@link FrickClient.upsertObject}.
 */
export interface ObjectBinding<T extends object = PlainObject> {
  readonly type: string;
  useAll(): Signal<T[]>;
  useOne(id: string): T | undefined;
  upsert(id: string, value: T, expectedVersion?: number): Promise<{ version: number }>;
}

/**
 * Stream binding. `useEvents` subscribes to the live tail. `append`
 * forwards to {@link FrickClient.append}. `loadOlder` issues an HTTP
 * scrollback read and returns the events without merging them into the
 * live tail (callers decide how to render history vs live).
 *
 * Event-name-keyed wrappers are surfaced as `stream[eventName].append(...)`
 * by the generator so consumers can call typed object and stream helpers.
 */
export interface StreamBinding<
  TEvent extends { event: string; payload: object } = { event: string; payload: PlainObject },
> {
  readonly stream: string;
  useEvents(key: string): Signal<TEvent[]>;
  append(key: string, event: TEvent["event"], payload: TEvent["payload"]): Promise<void>;
  loadOlder(key: string, count: number, before?: number): Promise<TEvent[]>;
}

export interface PresenceBinding<T extends object = PlainObject> {
  readonly name: string;
  useOne(key: string): Signal<T | undefined>;
  set(key: string, value: T): Promise<void>;
  clear(key: string): Promise<void>;
}

export interface SignalBinding<T extends object = PlainObject> {
  readonly name: string;
  useChannel(key: string): Signal<T[]>;
  send(key: string, value: T): Promise<void>;
}

export interface ProjectionBinding<T extends object = PlainObject> {
  readonly name: string;
  useRows(): Signal<Map<string, T>>;
}

/**
 * Generic (untyped at the value level) bindings flat-keyed by schema name.
 *
 * The runtime returns one entry per object / stream / presence / signal /
 * projection. The schema validator already enforces unique names within a
 * category; this layer additionally requires uniqueness *across* categories
 * (e.g. no object and signal sharing a name) — `bindSchema` throws a
 * `FrickBindingCollisionError` if it sees a collision.
 *
 * The generated typed surface in `packages/core/src/generated/bindings.ts`
 * narrows this flat shape to schema-specific bindings via an
 * `as unknown as FrickBindings` cast at the call site.
 */
export type AnyBinding =
  | ObjectBinding<object>
  | StreamBinding<{ event: string; payload: object }>
  | PresenceBinding<object>
  | SignalBinding<object>
  | ProjectionBinding<object>;

export type GenericBindings = Record<string, AnyBinding>;

export class FrickBindingCollisionError extends Error {
  constructor(public readonly name: string) {
    super(
      `Cannot bind schema: name "${name}" is used by more than one of object/stream/presence/signal/projection`,
    );
    this.name = "FrickBindingCollisionError";
  }
}

export function bindSchema(client: FrickClient, schema: FrickSchema): GenericBindings {
  const bindings: GenericBindings = {};

  function add(name: string, binding: AnyBinding): void {
    if (bindings[name]) throw new FrickBindingCollisionError(name);
    bindings[name] = binding;
  }

  for (const object of schema.objects) add(object.name, createObjectBinding(client, object.name));
  for (const stream of schema.streams) add(stream.name, createStreamBinding(client, stream.name));
  for (const presence of schema.presences) add(presence.name, createPresenceBinding(client, presence.name));
  for (const signal of schema.signals) add(signal.name, createSignalBinding(client, signal.name));
  for (const projection of schema.projections) add(projection.name, createProjectionBinding(client, projection.name));

  return bindings;
}

function createObjectBinding<T extends object = PlainObject>(
  client: FrickClient,
  type: string,
): ObjectBinding<T> {
  return {
    type,
    useAll: () => client.objects(type) as unknown as Signal<T[]>,
    useOne: (id) => client.object(type, id) as T | undefined,
    upsert: (id, value, expectedVersion) =>
      client.upsertObject(type, id, value as unknown as PlainObject, expectedVersion),
  };
}

function createStreamBinding<
  TEvent extends { event: string; payload: object } = { event: string; payload: PlainObject },
>(
  client: FrickClient,
  stream: string,
): StreamBinding<TEvent> {
  return {
    stream,
    useEvents: (key) =>
      // The runtime stores stream events as StreamEventInput[]. Cast to the
      // generator-narrowed union; the at-runtime shape is identical.
      client.stream(stream, key) as unknown as Signal<TEvent[]>,
    append: (key, event, payload) =>
      client.append(stream, key, event as string, payload as PlainObject),
    loadOlder: async (key, count, before) =>
      (await client.loadOlder(stream, key, count, before)) as unknown as TEvent[],
  };
}

function createPresenceBinding<T extends object = PlainObject>(
  client: FrickClient,
  name: string,
): PresenceBinding<T> {
  return {
    name,
    useOne: (key) => client.presence(name, key) as unknown as Signal<T | undefined>,
    set: (key, value) => client.setPresence(name, key, value as unknown as PlainObject),
    clear: (key) => client.clearPresence(name, key),
  };
}

function createSignalBinding<T extends object = PlainObject>(
  client: FrickClient,
  name: string,
): SignalBinding<T> {
  return {
    name,
    useChannel: (key) => client.signalChannel(name, key) as unknown as Signal<T[]>,
    send: (key, value) => client.sendSignal(name, key, value as unknown as PlainObject),
  };
}

function createProjectionBinding<T extends object = PlainObject>(
  client: FrickClient,
  name: string,
): ProjectionBinding<T> {
  return {
    name,
    useRows: () => client.projection(name) as unknown as Signal<Map<string, T>>,
  };
}

// Re-export `StreamEventInput` for ergonomic imports; `FrickClient` is
// already re-exported by `runtime.ts` (as a class value), so don't shadow it
// here with a type-only export — that prevents `new FrickClient(...)` at the
// `@frick/core` boundary.
export type { StreamEventInput };
