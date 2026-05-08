import { decode, encode } from "@msgpack/msgpack";
import type { FrickManifest, ObjectDelta, PackedObject } from "./schema.js";

export const PROTOCOL_VERSION = 1;

export enum FrameKind {
  Hello = 0,
  Manifest = 1,
  Subscribe = 2,
  Snapshot = 3,
  Mutate = 4,
  Delta = 5,
  Ack = 6,
  Reject = 7,
  SyncStatus = 8,
}

export interface QuerySpec {
  entity: string;
  index: string;
  args: Record<string, unknown>;
}

export interface HelloPayload {
  replicaId: string;
  schemaVersion: number;
  knownSeq: number;
}

export interface MutationFramePayload {
  requestId: string;
  name: string;
  input: Record<string, unknown>;
}

export type FrickFrame =
  | [FrameKind.Hello, HelloPayload]
  | [FrameKind.Manifest, FrickManifest]
  | [FrameKind.Subscribe, string, QuerySpec]
  | [FrameKind.Snapshot, string, PackedObject[]]
  | [FrameKind.Mutate, MutationFramePayload]
  | [FrameKind.Delta, ObjectDelta]
  | [FrameKind.Ack, string, ObjectDelta]
  | [FrameKind.Reject, string, string]
  | [FrameKind.SyncStatus, { connected: boolean; lastSeq: number }];

export function encodeFrame(frame: FrickFrame): Uint8Array {
  return encode(frame);
}

export function decodeFrame(payload: ArrayBuffer | Uint8Array | Buffer): FrickFrame {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  return decode(bytes) as FrickFrame;
}

export function isBinaryFrame(payload: unknown): payload is ArrayBuffer | Uint8Array | Buffer {
  return payload instanceof ArrayBuffer || payload instanceof Uint8Array || Buffer.isBuffer(payload);
}
