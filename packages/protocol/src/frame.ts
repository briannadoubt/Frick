import { decode, encode } from "@msgpack/msgpack";
import type {
  PackedPresenceRecord,
  PackedSignalEnvelope,
  PackedStreamEvent,
} from "./codec.js";
import type { FrickSchema, PackedRecord, PlainObject } from "./schema.js";

export const PROTOCOL_VERSION = 1;

export enum FrameKind {
  Hello = 0,
  Schema = 1,
  Subscribe = 2,
  Snapshot = 3,
  StreamPage = 4,
  Append = 5,
  Ack = 6,
  Nack = 7,
  Delta = 8,
  PresenceSet = 9,
  PresenceClear = 10,
  PresenceDelta = 11,
  SignalSend = 12,
  SignalDeliver = 13,
  CursorCommit = 14,
  Ping = 15,
  Pong = 16,
  SyncStatus = 17,
}

export type SubscriptionKind = "object" | "stream" | "presence" | "signal" | "projection";

export interface HelloPayload {
  replicaId: string;
  deviceId: string;
  schemaHash: string;
  knownCursors: Record<string, number>;
}

export interface SubscribePayload {
  subscriptionId: string;
  kind: SubscriptionKind;
  name: string;
  key?: string;
  cursor?: number;
}

export interface SnapshotPayload {
  subscriptionId: string;
  objects: PackedRecord[];
  cursor: number;
}

export interface StreamPagePayload {
  subscriptionId: string;
  events: PackedStreamEvent[];
  cursor: number;
  hasMore: boolean;
}

export interface AppendPayload {
  requestId: string;
  stream: string;
  key: string;
  event: string;
  payload: PlainObject;
}

export interface AckPayload {
  requestId: string;
  cursor?: number;
}

export interface NackPayload {
  requestId: string;
  code: string;
  message: string;
}

export interface DeltaPayload {
  objects: PackedRecord[];
  events: PackedStreamEvent[];
  cursor: number;
}

export interface PresenceSetPayload {
  requestId: string;
  name: string;
  key: string;
  value: PlainObject;
}

export interface PresenceClearPayload {
  requestId: string;
  name: string;
  key: string;
}

export interface PresenceDeltaPayload {
  subscriptionId: string;
  records: PackedPresenceRecord[];
  cleared: string[];
}

export interface SignalPayload {
  requestId: string;
  name: string;
  key: string;
  value: PlainObject;
}

export interface SignalDeliverPayload {
  envelope: PackedSignalEnvelope;
}

export interface CursorCommitPayload {
  subscriptionId: string;
  cursor: number;
}

export type FrickFrame =
  | [FrameKind.Hello, HelloPayload]
  | [FrameKind.Schema, FrickSchema]
  | [FrameKind.Subscribe, SubscribePayload]
  | [FrameKind.Snapshot, SnapshotPayload]
  | [FrameKind.StreamPage, StreamPagePayload]
  | [FrameKind.Append, AppendPayload]
  | [FrameKind.Ack, AckPayload]
  | [FrameKind.Nack, NackPayload]
  | [FrameKind.Delta, DeltaPayload]
  | [FrameKind.PresenceSet, PresenceSetPayload]
  | [FrameKind.PresenceClear, PresenceClearPayload]
  | [FrameKind.PresenceDelta, PresenceDeltaPayload]
  | [FrameKind.SignalSend, SignalPayload]
  | [FrameKind.SignalDeliver, SignalDeliverPayload]
  | [FrameKind.CursorCommit, CursorCommitPayload]
  | [FrameKind.Ping, { sentAt: number }]
  | [FrameKind.Pong, { sentAt: number; receivedAt: number }]
  | [FrameKind.SyncStatus, { connected: boolean; cursors: Record<string, number>; inFlight: number }];

export function encodeFrame(frame: FrickFrame): Uint8Array {
  return encode(frame);
}

export function decodeFrame(payload: ArrayBuffer | Uint8Array): FrickFrame {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  return decode(bytes) as FrickFrame;
}

export function isBinaryFrame(payload: unknown): payload is ArrayBuffer | Uint8Array {
  return payload instanceof ArrayBuffer || payload instanceof Uint8Array;
}

export function rejectSchemaMismatch(clientHash: string, serverHash: string): void {
  if (clientHash !== serverHash) {
    throw new Error(`Schema mismatch: client=${clientHash} server=${serverHash}`);
  }
}
