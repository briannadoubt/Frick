/**
 * Stable error codes mirrored from `packages/protocol/src/errors.ts`.
 * Generated; do not edit by hand. Use [fromWire] to translate strings
 * arriving from the server, including future codes the client doesn't yet
 * know about (those round-trip as `null`).
 */
enum class FrickErrorCode(val wireValue: String) {
  AUTH_UNAUTHENTICATED("auth.unauthenticated"),
  AUTH_FORBIDDEN("auth.forbidden"),
  AUTH_SESSION_EXPIRED("auth.sessionExpired"),
  SCHEMA_INCOMPATIBLE("schema.incompatible"),
  SCHEMA_MIGRATION_REQUIRED("schema.migrationRequired"),
  STORAGE_CONFLICT("storage.conflict"),
  STORAGE_NOT_FOUND("storage.notFound"),
  STREAM_APPEND_REJECTED("stream.appendRejected"),
  STREAM_INVALID_CURSOR("stream.invalidCursor"),
  SYNC_PROTOCOL_ERROR("sync.protocolError"),
  SYNC_RECONNECT_EXHAUSTED("sync.reconnectExhausted"),
  BLOB_TOO_LARGE("blob.tooLarge"),
  BLOB_UNSUPPORTED_CONTENT_TYPE("blob.unsupportedContentType"),
  BLOB_QUOTA_EXCEEDED("blob.quotaExceeded"),
  RATE_LIMIT_EXCEEDED("rateLimit.exceeded"),
  SERVER_INTERNAL("server.internal"),
  ;
  companion object {
    private val BY_WIRE: Map<String, FrickErrorCode> = mapOf(
      "auth.unauthenticated" to AUTH_UNAUTHENTICATED,
      "auth.forbidden" to AUTH_FORBIDDEN,
      "auth.sessionExpired" to AUTH_SESSION_EXPIRED,
      "schema.incompatible" to SCHEMA_INCOMPATIBLE,
      "schema.migrationRequired" to SCHEMA_MIGRATION_REQUIRED,
      "storage.conflict" to STORAGE_CONFLICT,
      "storage.notFound" to STORAGE_NOT_FOUND,
      "stream.appendRejected" to STREAM_APPEND_REJECTED,
      "stream.invalidCursor" to STREAM_INVALID_CURSOR,
      "sync.protocolError" to SYNC_PROTOCOL_ERROR,
      "sync.reconnectExhausted" to SYNC_RECONNECT_EXHAUSTED,
      "blob.tooLarge" to BLOB_TOO_LARGE,
      "blob.unsupportedContentType" to BLOB_UNSUPPORTED_CONTENT_TYPE,
      "blob.quotaExceeded" to BLOB_QUOTA_EXCEEDED,
      "rateLimit.exceeded" to RATE_LIMIT_EXCEEDED,
      "server.internal" to SERVER_INTERNAL,
    )
    fun fromWire(value: String?): FrickErrorCode? = value?.let { BY_WIRE[it] }
  }
}