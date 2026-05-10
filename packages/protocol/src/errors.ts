export type FrickErrorCode =
  | "auth.unauthenticated"
  | "auth.forbidden"
  | "auth.sessionExpired"
  | "schema.incompatible"
  | "schema.migrationRequired"
  | "storage.conflict"
  | "storage.notFound"
  | "stream.appendRejected"
  | "sync.protocolError"
  | "sync.reconnectExhausted"
  | "blob.tooLarge"
  | "blob.unsupportedContentType"
  | "rateLimit.exceeded"
  | "server.internal";

const FRICK_ERROR_CODES = new Set<FrickErrorCode>([
  "auth.unauthenticated",
  "auth.forbidden",
  "auth.sessionExpired",
  "schema.incompatible",
  "schema.migrationRequired",
  "storage.conflict",
  "storage.notFound",
  "stream.appendRejected",
  "sync.protocolError",
  "sync.reconnectExhausted",
  "blob.tooLarge",
  "blob.unsupportedContentType",
  "rateLimit.exceeded",
  "server.internal",
]);

export interface FrickErrorEnvelope {
  code: FrickErrorCode;
  message: string;
  requestId: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  schemaHash?: string;
  schemaRevision?: number;
}

export function createFrickErrorEnvelope(input: FrickErrorEnvelope): FrickErrorEnvelope {
  return { ...input };
}

export function isFrickErrorEnvelope(value: unknown): value is FrickErrorEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }
  const envelope = value as Partial<FrickErrorEnvelope>;
  if (
    typeof envelope.code !== "string" ||
    !FRICK_ERROR_CODES.has(envelope.code as FrickErrorCode) ||
    typeof envelope.message !== "string" ||
    typeof envelope.requestId !== "string" ||
    typeof envelope.retryable !== "boolean"
  ) {
    return false;
  }
  if (envelope.details !== undefined) {
    if (typeof envelope.details !== "object" || envelope.details === null || Array.isArray(envelope.details)) {
      return false;
    }
  }
  if (envelope.schemaHash !== undefined && typeof envelope.schemaHash !== "string") {
    return false;
  }
  if (envelope.schemaRevision !== undefined && !Number.isInteger(envelope.schemaRevision)) {
    return false;
  }
  return true;
}
