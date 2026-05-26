import Foundation

// `FrickErrorCode` is generated into FrickGenerated.swift from the
// foundation schema's error table; the static-let extensible struct
// that used to live here was superseded when schema codegen took over.

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

public struct FrickAuthenticationRequiredError: Error, Equatable, Sendable {
    public let message: String

    public init(message: String = "Frick requires an authenticated session for this operation") {
        self.message = message
    }
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

public struct FrickCacheMetadata: Codable, Equatable, Sendable {
    public let schemaId: String
    public let schemaVersion: String
    public let schemaRevision: Int
    public let schemaHash: String
    public let tenantId: String?
    public let userId: String?

    public init(
        schemaId: String,
        schemaVersion: String,
        schemaRevision: Int,
        schemaHash: String,
        tenantId: String? = nil,
        userId: String? = nil
    ) {
        self.schemaId = schemaId
        self.schemaVersion = schemaVersion
        self.schemaRevision = schemaRevision
        self.schemaHash = schemaHash
        self.tenantId = tenantId
        self.userId = userId
    }
}

public extension FrickCacheMetadata {
    static var currentSchema: FrickCacheMetadata {
        currentSchema()
    }

    static func currentSchema(
        tenantId: String? = nil,
        userId: String? = nil,
        schemaHash: String = FrickSchema.schemaHash
    ) -> FrickCacheMetadata {
        FrickCacheMetadata(
            schemaId: FrickSchema.schemaId,
            schemaVersion: FrickSchema.schemaVersion,
            schemaRevision: FrickSchema.schemaRevision,
            schemaHash: schemaHash,
            tenantId: tenantId,
            userId: userId
        )
    }

    static func currentSchema(session: FrickSession?, schemaHash: String = FrickSchema.schemaHash) -> FrickCacheMetadata {
        currentSchema(tenantId: session?.tenantId, userId: session?.userId, schemaHash: schemaHash)
    }
}

public enum FrickCacheIncompatibilityReason: String, Codable, Equatable, Sendable {
    case schemaIdMismatch
    case cacheTooOld
    case sessionScopeMismatch
}

public struct FrickCacheIncompatibleError: Error, Equatable, Sendable {
    public let reason: FrickCacheIncompatibilityReason
    public let cachedMetadata: FrickCacheMetadata
    public let currentMetadata: FrickCacheMetadata
    public let minimumClientRevision: Int
    public let pendingAppendCount: Int

    public init(
        reason: FrickCacheIncompatibilityReason,
        cachedMetadata: FrickCacheMetadata,
        currentMetadata: FrickCacheMetadata,
        minimumClientRevision: Int,
        pendingAppendCount: Int
    ) {
        self.reason = reason
        self.cachedMetadata = cachedMetadata
        self.currentMetadata = currentMetadata
        self.minimumClientRevision = minimumClientRevision
        self.pendingAppendCount = pendingAppendCount
    }
}

public enum FrickCacheCompatibility {
    public static func reason(
        cached: FrickCacheMetadata,
        current: FrickCacheMetadata,
        minimumClientRevision: Int
    ) -> FrickCacheIncompatibilityReason? {
        if cached.schemaId != current.schemaId {
            return .schemaIdMismatch
        }
        if cached.schemaRevision < minimumClientRevision {
            return .cacheTooOld
        }
        if current.tenantId != nil, cached.tenantId != current.tenantId {
            return .sessionScopeMismatch
        }
        if current.userId != nil, cached.userId != current.userId {
            return .sessionScopeMismatch
        }
        return nil
    }
}
