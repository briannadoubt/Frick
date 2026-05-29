import Foundation

/// Permission a {@link FrickInvitation} carries (and the corresponding
/// {@link FrickGrant} confers). The framework's authz flow treats `"write"`
/// as a superset of `"read"`: a write-grant satisfies an `object.read`
/// check, but a read-grant does not satisfy an `object.write` check.
public enum FrickSharingPermission: String, Codable, Sendable, Equatable {
    case read
    case write
}


/// Transient, single-use token an owner ships to a recipient. The
/// recipient calls `acceptInvitation(token:)` to redeem; the server marks
/// `redeemedAt` on the first successful accept and rejects every
/// subsequent attempt. Default lifetime is 14 days.
public struct FrickInvitation: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let tenantId: String
    public let ownerUserId: String
    public let recordType: String
    public let recordId: String
    public let permission: FrickSharingPermission
    public let token: String
    public let createdAt: String
    public let expiresAt: String
    public let redeemedAt: String?
    public let redeemedByUserId: String?

    public init(
        id: String,
        tenantId: String,
        ownerUserId: String,
        recordType: String,
        recordId: String,
        permission: FrickSharingPermission,
        token: String,
        createdAt: String,
        expiresAt: String,
        redeemedAt: String? = nil,
        redeemedByUserId: String? = nil
    ) {
        self.id = id
        self.tenantId = tenantId
        self.ownerUserId = ownerUserId
        self.recordType = recordType
        self.recordId = recordId
        self.permission = permission
        self.token = token
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.redeemedAt = redeemedAt
        self.redeemedByUserId = redeemedByUserId
    }
}


/// Durable "user U has permission P on record R" record. Created when a
/// recipient redeems an invitation; revoked when the owner calls
/// `revokeGrant(grantId:)`. The framework's authz flow only honours grants
/// where `revokedAt == nil`.
public struct FrickGrant: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let tenantId: String
    public let ownerUserId: String
    public let recordType: String
    public let recordId: String
    public let granteeUserId: String
    public let permission: FrickSharingPermission
    public let createdAt: String
    public let revokedAt: String?

    public init(
        id: String,
        tenantId: String,
        ownerUserId: String,
        recordType: String,
        recordId: String,
        granteeUserId: String,
        permission: FrickSharingPermission,
        createdAt: String,
        revokedAt: String? = nil
    ) {
        self.id = id
        self.tenantId = tenantId
        self.ownerUserId = ownerUserId
        self.recordType = recordType
        self.recordId = recordId
        self.granteeUserId = granteeUserId
        self.permission = permission
        self.createdAt = createdAt
        self.revokedAt = revokedAt
    }
}


struct CreateInvitationBody: Encodable {
    let recordType: String
    let recordId: String
    let permission: FrickSharingPermission
    let expiresInSeconds: Int?
}


struct CreateInvitationEnvelope: Decodable {
    let invitation: FrickInvitation
}


struct AcceptInvitationBody: Encodable {
    let token: String
}


struct AcceptInvitationEnvelope: Decodable {
    let grant: FrickGrant
}


struct ListGrantsEnvelope: Decodable {
    let grants: [FrickGrant]
}


struct RevokeGrantEnvelope: Decodable {
    let grant: FrickGrant
}
