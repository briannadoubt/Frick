/// Stable error codes mirrored from `packages/protocol/src/errors.ts`.
/// Generated; do not edit by hand. Decode wire strings via
/// `FrickErrorCode(rawValue: ...)` — unknown future codes return `nil`
/// so callers can fall back to a `.serverInternal` bucket.
public enum FrickErrorCode: String, Codable, CaseIterable, Sendable {
  case authUnauthenticated = "auth.unauthenticated"
  case authForbidden = "auth.forbidden"
  case authSessionExpired = "auth.sessionExpired"
  case schemaIncompatible = "schema.incompatible"
  case schemaMigrationRequired = "schema.migrationRequired"
  case storageConflict = "storage.conflict"
  case storageNotFound = "storage.notFound"
  case streamAppendRejected = "stream.appendRejected"
  case streamInvalidCursor = "stream.invalidCursor"
  case syncProtocolError = "sync.protocolError"
  case syncReconnectExhausted = "sync.reconnectExhausted"
  case blobTooLarge = "blob.tooLarge"
  case blobUnsupportedContentType = "blob.unsupportedContentType"
  case blobQuotaExceeded = "blob.quotaExceeded"
  case rateLimitExceeded = "rateLimit.exceeded"
  case serverInternal = "server.internal"
}
