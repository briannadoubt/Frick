/**
 * Canonical list of error codes the Frick framework emits in
 * {@link FrickErrorEnvelope}. The codegen in
 * `packages/protocol/src/generators/error-enums.ts` imports this array and
 * emits language-specific enums for Swift / Kotlin / generated TS clients,
 * so adding a new code here automatically lights it up everywhere.
 *
 * Codes are dotted-namespace strings; the first segment is the subsystem
 * (auth, schema, storage, stream, sync, blob, rateLimit, server) and the
 * second segment is the specific failure (unauthenticated, conflict, …).
 */
export const FRICK_ERROR_CODES = [
  "auth.unauthenticated",
  "auth.forbidden",
  "auth.sessionExpired",
  "schema.incompatible",
  "schema.migrationRequired",
  "storage.conflict",
  "storage.notFound",
  "stream.appendRejected",
  "stream.invalidCursor",
  "sync.protocolError",
  "sync.reconnectExhausted",
  "blob.tooLarge",
  "blob.unsupportedContentType",
  "blob.quotaExceeded",
  "rateLimit.exceeded",
  "server.internal",
] as const;

export type FrickErrorCode = (typeof FRICK_ERROR_CODES)[number];

const FRICK_ERROR_CODE_SET = new Set<FrickErrorCode>(FRICK_ERROR_CODES);

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
    !FRICK_ERROR_CODE_SET.has(envelope.code as FrickErrorCode) ||
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
