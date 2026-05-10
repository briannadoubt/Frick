import type { FrickSchema } from "./schema.js";

export type FrickClientPlatform = "web" | "node" | "ios" | "macos" | "android" | "test" | "service";
export type FrickTransportCapability = "websocket" | "http" | "sse";
export type FrickEncodingCapability = "msgpack" | "json";
export type FrickPrimitiveCapability =
  | "objects"
  | "streams"
  | "presence"
  | "signals"
  | "blobs"
  | "jobs"
  | "projections";
export type FrickBlobUploadCapability = "direct" | "resumable" | "signedUrl" | "localOnly";
export type FrickPushCapability = "apns" | "fcm" | "webPush" | "test";

export interface FrickSchemaCapability {
  schemaId: string;
  schemaRevision: number;
  schemaHash: string;
}

export interface FrickClientCapabilities {
  platform: FrickClientPlatform;
  sdkVersion: string;
  schema: FrickSchemaCapability;
  transports: FrickTransportCapability[];
  encodings: FrickEncodingCapability[];
  primitives: FrickPrimitiveCapability[];
  offline: {
    cache: boolean;
    pendingAppends: boolean;
  };
  blobUploads: FrickBlobUploadCapability[];
  push: FrickPushCapability[];
  experimental: string[];
  required: string[];
}

export interface FrickServerCapabilities {
  schema: FrickSchemaCapability;
  transports: FrickTransportCapability[];
  encodings: FrickEncodingCapability[];
  primitives: FrickPrimitiveCapability[];
  blobUploads: FrickBlobUploadCapability[];
  push: FrickPushCapability[];
  experimental: string[];
  limits: Record<string, number>;
}

export function schemaCapability(schema: FrickSchema): FrickSchemaCapability {
  return {
    schemaId: schema.schemaId,
    schemaRevision: schema.schemaRevision,
    schemaHash: schema.hash,
  };
}

export function defaultClientCapabilities(input: {
  platform: FrickClientPlatform;
  sdkVersion: string;
  schema: FrickSchema;
}): FrickClientCapabilities {
  return {
    platform: input.platform,
    sdkVersion: input.sdkVersion,
    schema: schemaCapability(input.schema),
    transports: ["websocket"],
    encodings: ["msgpack"],
    primitives: ["objects", "streams", "presence", "signals"],
    offline: { cache: true, pendingAppends: true },
    blobUploads: ["direct"],
    push: [],
    experimental: [],
    required: [],
  };
}

export function defaultServerCapabilities(schema: FrickSchema): FrickServerCapabilities {
  return {
    schema: schemaCapability(schema),
    transports: ["websocket", "http"],
    encodings: ["msgpack", "json"],
    primitives: ["objects", "streams", "presence", "signals", "blobs", "jobs", "projections"],
    blobUploads: ["direct"],
    push: [],
    experimental: [],
    limits: {},
  };
}
