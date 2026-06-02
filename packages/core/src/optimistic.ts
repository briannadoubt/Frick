/**
 * Display-only optimistic overlay.
 *
 * When a consumer calls `client.append(stream, key, event, payload, { optimistic })`
 * the runtime synthesizes a `StreamEventInput` (or a `PlainObject` for
 * object upserts), stashes it in this overlay keyed by the mutation's
 * `requestId`, and republishes the affected stream/object signal so the
 * UI sees the change immediately.
 *
 * On Ack the overlay entry is removed and the real Delta event (which
 * arrives independently) takes its place — there's typically zero visible
 * gap because the server sends Delta before Ack on the same socket.
 *
 * On Nack the overlay entry is removed and the original mutation Promise
 * rejects with `OptimisticConflictError` (or the underlying typed error),
 * letting the UI roll back, re-prompt, or surface the failure.
 *
 * Design intent: the overlay is **display-only**. The server still gates
 * every write through its normal authorization and `versionPrecondition`
 * checks; the overlay never speculatively writes anything to the cache.
 * That's why a conflict can't corrupt durable state — the worst case is a
 * brief flash of an event the server then rejects.
 */

import type { FrickErrorEnvelope, PlainObject, StreamEventInput } from "@fricken/protocol";

/**
 * Surfaced from `useAppend` / `useUpsertObject` when an optimistic mutation
 * is nacked with a `storage.conflict` envelope. Standalone class (not
 * extending `FrickObjectConflictError`) to avoid a circular import between
 * `runtime.ts` and this module — callers that want to handle both via the
 * same catch can do `instanceof OptimisticConflictError` and read the
 * carried fields directly.
 */
export class OptimisticConflictError extends Error {
  readonly envelope: FrickErrorEnvelope;
  readonly expectedVersion: number | undefined;
  readonly actualVersion: number;
  readonly mergePolicy: "lastWriteWins" | "versionPrecondition";
  readonly rolledBack: true;
  constructor(input: {
    envelope: FrickErrorEnvelope;
    expectedVersion: number | undefined;
    actualVersion: number;
    mergePolicy: "lastWriteWins" | "versionPrecondition";
    rolledBack: true;
  }) {
    super(input.envelope.message);
    this.name = "OptimisticConflictError";
    this.envelope = input.envelope;
    this.expectedVersion = input.expectedVersion;
    this.actualVersion = input.actualVersion;
    this.mergePolicy = input.mergePolicy;
    this.rolledBack = input.rolledBack;
  }
}

interface OverlayStreamEntry {
  kind: "stream";
  stream: string;
  key: string;
  event: StreamEventInput;
}

interface OverlayObjectEntry {
  kind: "object";
  type: string;
  id: string;
  value: PlainObject;
}

type OverlayEntry = OverlayStreamEntry | OverlayObjectEntry;

type Listener = () => void;

export class OptimisticOverlay {
  readonly #entries = new Map<string, OverlayEntry>();
  readonly #streamListeners = new Map<string, Set<Listener>>();
  readonly #objectListeners = new Map<string, Set<Listener>>();

  /** Reserve and publish an optimistic stream event. Returns the synthesized event for consumers that want to read it back. */
  addStreamEvent(requestId: string, entry: Omit<OverlayStreamEntry, "kind">): StreamEventInput {
    this.#entries.set(requestId, { kind: "stream", ...entry });
    this.#notifyStream(entry.stream, entry.key);
    return entry.event;
  }

  /** Reserve and publish an optimistic object upsert. */
  addObjectUpsert(requestId: string, entry: Omit<OverlayObjectEntry, "kind">): void {
    this.#entries.set(requestId, { kind: "object", ...entry });
    this.#notifyObject(entry.type);
  }

  /** Drop an overlay entry (called on Ack and on Nack). Idempotent. */
  remove(requestId: string): void {
    const entry = this.#entries.get(requestId);
    if (!entry) return;
    this.#entries.delete(requestId);
    if (entry.kind === "stream") this.#notifyStream(entry.stream, entry.key);
    else this.#notifyObject(entry.type);
  }

  /** Snapshot of pending stream events for `(stream, key)`, in mutation order. */
  forStream(stream: string, key: string): StreamEventInput[] {
    const out: StreamEventInput[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.kind === "stream" && entry.stream === stream && entry.key === key) {
        out.push(entry.event);
      }
    }
    return out;
  }

  /** Snapshot of pending object upserts for `type`, keyed by id. Last-write-wins per id (most recent overlay shadows earlier). */
  forObjectType(type: string): Map<string, PlainObject> {
    const out = new Map<string, PlainObject>();
    for (const entry of this.#entries.values()) {
      if (entry.kind === "object" && entry.type === type) {
        out.set(entry.id, entry.value);
      }
    }
    return out;
  }

  /** Listen for changes to pending stream events for `(stream, key)`. Returns an unsubscribe. */
  subscribeStream(stream: string, key: string, listener: Listener): () => void {
    const id = `${stream}\x00${key}`;
    let set = this.#streamListeners.get(id);
    if (!set) {
      set = new Set();
      this.#streamListeners.set(id, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.#streamListeners.delete(id);
    };
  }

  /** Listen for changes to pending object upserts for a type. Returns an unsubscribe. */
  subscribeObjectType(type: string, listener: Listener): () => void {
    let set = this.#objectListeners.get(type);
    if (!set) {
      set = new Set();
      this.#objectListeners.set(type, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.#objectListeners.delete(type);
    };
  }

  /** Clear every overlay entry. Used on disconnect when the consumer wants to drop in-flight optimism. */
  clear(): void {
    if (this.#entries.size === 0) return;
    const streams = new Set<string>();
    const types = new Set<string>();
    for (const entry of this.#entries.values()) {
      if (entry.kind === "stream") streams.add(`${entry.stream}\x00${entry.key}`);
      else types.add(entry.type);
    }
    this.#entries.clear();
    for (const id of streams) {
      const [stream, key] = id.split("\x00") as [string, string];
      this.#notifyStream(stream, key);
    }
    for (const type of types) this.#notifyObject(type);
  }

  #notifyStream(stream: string, key: string): void {
    const id = `${stream}\x00${key}`;
    const set = this.#streamListeners.get(id);
    if (!set) return;
    for (const listener of set) listener();
  }

  #notifyObject(type: string): void {
    const set = this.#objectListeners.get(type);
    if (!set) return;
    for (const listener of set) listener();
  }
}
