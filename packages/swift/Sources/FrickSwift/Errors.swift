import Foundation

public struct FrickErrorCode: RawRepresentable, Codable, Equatable, Hashable, Sendable {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let authUnauthenticated = FrickErrorCode(rawValue: "auth.unauthenticated")
    public static let authForbidden = FrickErrorCode(rawValue: "auth.forbidden")
    public static let authSessionExpired = FrickErrorCode(rawValue: "auth.sessionExpired")
    public static let schemaIncompatible = FrickErrorCode(rawValue: "schema.incompatible")
    public static let schemaMigrationRequired = FrickErrorCode(rawValue: "schema.migrationRequired")
    public static let storageConflict = FrickErrorCode(rawValue: "storage.conflict")
    public static let storageNotFound = FrickErrorCode(rawValue: "storage.notFound")
    public static let streamAppendRejected = FrickErrorCode(rawValue: "stream.appendRejected")
    public static let syncProtocolError = FrickErrorCode(rawValue: "sync.protocolError")
    public static let syncReconnectExhausted = FrickErrorCode(rawValue: "sync.reconnectExhausted")
    public static let blobTooLarge = FrickErrorCode(rawValue: "blob.tooLarge")
    public static let blobUnsupportedContentType = FrickErrorCode(rawValue: "blob.unsupportedContentType")
    public static let rateLimitExceeded = FrickErrorCode(rawValue: "rateLimit.exceeded")
    public static let serverInternal = FrickErrorCode(rawValue: "server.internal")
}

public struct FrickErrorEnvelope: Codable, Equatable, Sendable {
    public let code: FrickErrorCode
    public let message: String
    public let requestId: String
    public let retryable: Bool
    public let details: [String: FrickJSONValue]?
    public let schemaHash: String?
    public let schemaRevision: Int?

    public init(
        code: FrickErrorCode,
        message: String,
        requestId: String,
        retryable: Bool,
        details: [String: FrickJSONValue]? = nil,
        schemaHash: String? = nil,
        schemaRevision: Int? = nil
    ) {
        self.code = code
        self.message = message
        self.requestId = requestId
        self.retryable = retryable
        self.details = details
        self.schemaHash = schemaHash
        self.schemaRevision = schemaRevision
    }
}

public struct FrickServerError: Error, Equatable, Sendable {
    public let httpStatusCode: Int
    public let envelope: FrickErrorEnvelope?
    public let body: Data

    public init(httpStatusCode: Int, envelope: FrickErrorEnvelope?, body: Data) {
        self.httpStatusCode = httpStatusCode
        self.envelope = envelope
        self.body = body
    }

    public var code: FrickErrorCode? { envelope?.code }
    public var message: String? { envelope?.message }
    public var requestId: String? { envelope?.requestId }
    public var retryable: Bool { envelope?.retryable ?? false }
}

struct FrickHttpErrorBody: Decodable {
    let error: FrickErrorEnvelope?
}

enum FrickErrorEnvelopeDecoder {
    static func decode(from data: Data, using decoder: JSONDecoder = JSONDecoder()) -> FrickErrorEnvelope? {
        guard !data.isEmpty else {
            return nil
        }
        if let body = try? decoder.decode(FrickHttpErrorBody.self, from: data), let envelope = body.error {
            return envelope
        }
        return try? decoder.decode(FrickErrorEnvelope.self, from: data)
    }
}
