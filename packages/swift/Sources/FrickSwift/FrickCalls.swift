import Foundation

/// FR-15 / FR-80 / FR-82 — Swift mirror of the call control-plane wire contract.
///
/// These are the Swift analogues of `packages/protocol/src/calls.ts`: the
/// server-authoritative lifecycle *commands* (`CallCommand`, frame kind 21)
/// and the typed *result* (`CallCommandResult`, frame kind 22) that the plain
/// `Ack` frame can't carry. Failures reuse the existing `Nack` frame keyed by
/// the same `requestId`, so the call path rides the same correlation plumbing
/// as Append/ObjectUpsert.
///
/// The call *records* (`CallRoom` / `CallInvite` / `CallParticipant`) also sync
/// to clients as ordinary object records; WebRTC SDP/ICE rides the existing
/// `SignalSend`/`SignalDeliver` relay as an opaque payload — none of that is
/// modeled here.

// MARK: - Enumerations

/// Audio-only vs audio+video call (FR-79). Mirrors TS `CallKind`.
public enum FrickCallKind: String, Sendable, Equatable {
    case audio
    case video
}

/// Lifecycle states a `CallRoom` moves through. Mirrors TS `CallRoomState`.
public enum FrickCallRoomState: String, Sendable, Equatable {
    case ringing
    case active
    case ended
}

/// Lifecycle states a `CallInvite` moves through. Mirrors TS `CallInviteState`.
public enum FrickCallInviteState: String, Sendable, Equatable {
    case ringing
    case accepted
    case declined
    case cancelled
}

/// Lifecycle states a `CallParticipant` moves through. Mirrors TS
/// `CallParticipantState`.
public enum FrickCallParticipantState: String, Sendable, Equatable {
    case joined
    case left
}

/// Coarse network-quality bucket surfaced on the participant model (FR-82).
/// Mirrors TS `CallNetworkQuality`.
public enum FrickCallNetworkQuality: String, Sendable, Equatable {
    case unknown
    case poor
    case fair
    case good
    case excellent
}

// MARK: - Records

/// Server-authoritative call room record. Mirrors TS `CallRoomRecord`.
public struct FrickCallRoomRecord: Sendable, Equatable {
    public let id: String
    public let conversationId: String
    public let state: FrickCallRoomState
    public let createdBy: String
    public let kind: FrickCallKind
    public let createdAt: String
    public let startedAt: String?
    public let endedAt: String?
    public let mediaSessionId: String?
    public let transport: String?

    public init(
        id: String,
        conversationId: String,
        state: FrickCallRoomState,
        createdBy: String,
        kind: FrickCallKind,
        createdAt: String,
        startedAt: String? = nil,
        endedAt: String? = nil,
        mediaSessionId: String? = nil,
        transport: String? = nil
    ) {
        self.id = id
        self.conversationId = conversationId
        self.state = state
        self.createdBy = createdBy
        self.kind = kind
        self.createdAt = createdAt
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.mediaSessionId = mediaSessionId
        self.transport = transport
    }

    init?(map: [String: FrickMsgPackValue]) {
        guard let id = map["id"]?.stringValue,
              let conversationId = map["conversationId"]?.stringValue,
              let createdBy = map["createdBy"]?.stringValue,
              let createdAt = map["createdAt"]?.stringValue else { return nil }
        self.id = id
        self.conversationId = conversationId
        self.state = map["state"]?.stringValue.flatMap(FrickCallRoomState.init(rawValue:)) ?? .ringing
        self.createdBy = createdBy
        self.kind = map["kind"]?.stringValue.flatMap(FrickCallKind.init(rawValue:)) ?? .audio
        self.createdAt = createdAt
        self.startedAt = map["startedAt"]?.stringValue
        self.endedAt = map["endedAt"]?.stringValue
        self.mediaSessionId = map["mediaSessionId"]?.stringValue
        self.transport = map["transport"]?.stringValue
    }

    /// Build a record from a synced `FrickObjectRecord` (named-field strings).
    /// Returns `nil` for a row missing the required fields.
    public init?(record: FrickObjectRecord) {
        let f = record.value
        guard let conversationId = f["conversationId"],
              let createdBy = f["createdBy"],
              let createdAt = f["createdAt"] else { return nil }
        self.id = record.id
        self.conversationId = conversationId
        self.state = f["state"].flatMap(FrickCallRoomState.init(rawValue:)) ?? .ringing
        self.createdBy = createdBy
        self.kind = f["kind"].flatMap(FrickCallKind.init(rawValue:)) ?? .audio
        self.createdAt = createdAt
        self.startedAt = f["startedAt"]
        self.endedAt = f["endedAt"]
        self.mediaSessionId = f["mediaSessionId"]
        self.transport = f["transport"]
    }
}

/// Server-authoritative invite record. Mirrors TS `CallInviteRecord`.
public struct FrickCallInviteRecord: Sendable, Equatable {
    public let id: String
    public let callId: String
    public let inviteeUserId: String
    public let status: FrickCallInviteState
    public let invitedBy: String
    public let invitedAt: String
    public let respondedAt: String?

    public init(
        id: String,
        callId: String,
        inviteeUserId: String,
        status: FrickCallInviteState,
        invitedBy: String,
        invitedAt: String,
        respondedAt: String? = nil
    ) {
        self.id = id
        self.callId = callId
        self.inviteeUserId = inviteeUserId
        self.status = status
        self.invitedBy = invitedBy
        self.invitedAt = invitedAt
        self.respondedAt = respondedAt
    }

    init?(map: [String: FrickMsgPackValue]) {
        guard let id = map["id"]?.stringValue,
              let callId = map["callId"]?.stringValue,
              let inviteeUserId = map["inviteeUserId"]?.stringValue,
              let invitedBy = map["invitedBy"]?.stringValue,
              let invitedAt = map["invitedAt"]?.stringValue else { return nil }
        self.id = id
        self.callId = callId
        self.inviteeUserId = inviteeUserId
        self.status = map["status"]?.stringValue.flatMap(FrickCallInviteState.init(rawValue:)) ?? .ringing
        self.invitedBy = invitedBy
        self.invitedAt = invitedAt
        self.respondedAt = map["respondedAt"]?.stringValue
    }
}

/// Server-authoritative participant record. Mirrors TS `CallParticipantRecord`,
/// including the FR-82 call-presence surface (mic / camera / screen-share and
/// the optional `speaking` / `networkQuality` fields a media adapter reports).
public struct FrickCallParticipantRecord: Sendable, Equatable {
    public let id: String
    public let callId: String
    public let userId: String
    public let deviceId: String
    public let state: FrickCallParticipantState
    public let joinedAt: String
    public let leftAt: String?
    public let micEnabled: Bool
    public let cameraEnabled: Bool
    public let screenSharing: Bool
    /// FR-82: whether the participant is currently detected as speaking.
    public let speaking: Bool?
    /// FR-82: coarse network-quality bucket for this participant's media link.
    public let networkQuality: FrickCallNetworkQuality?

    public init(
        id: String,
        callId: String,
        userId: String,
        deviceId: String,
        state: FrickCallParticipantState,
        joinedAt: String,
        leftAt: String? = nil,
        micEnabled: Bool,
        cameraEnabled: Bool,
        screenSharing: Bool,
        speaking: Bool? = nil,
        networkQuality: FrickCallNetworkQuality? = nil
    ) {
        self.id = id
        self.callId = callId
        self.userId = userId
        self.deviceId = deviceId
        self.state = state
        self.joinedAt = joinedAt
        self.leftAt = leftAt
        self.micEnabled = micEnabled
        self.cameraEnabled = cameraEnabled
        self.screenSharing = screenSharing
        self.speaking = speaking
        self.networkQuality = networkQuality
    }

    init?(map: [String: FrickMsgPackValue]) {
        guard let id = map["id"]?.stringValue,
              let callId = map["callId"]?.stringValue,
              let userId = map["userId"]?.stringValue,
              let deviceId = map["deviceId"]?.stringValue,
              let joinedAt = map["joinedAt"]?.stringValue else { return nil }
        self.id = id
        self.callId = callId
        self.userId = userId
        self.deviceId = deviceId
        self.state = map["state"]?.stringValue.flatMap(FrickCallParticipantState.init(rawValue:)) ?? .joined
        self.joinedAt = joinedAt
        self.leftAt = map["leftAt"]?.stringValue
        self.micEnabled = map["micEnabled"]?.boolValue ?? false
        self.cameraEnabled = map["cameraEnabled"]?.boolValue ?? false
        self.screenSharing = map["screenSharing"]?.boolValue ?? false
        self.speaking = map["speaking"]?.boolValue
        self.networkQuality = map["networkQuality"]?.stringValue.flatMap(FrickCallNetworkQuality.init(rawValue:))
    }

    /// Build a record from a synced `FrickObjectRecord` (named-field strings).
    /// The wire packs all field values as strings, so the booleans are parsed
    /// leniently (`"true"`/`"1"`). Returns `nil` for a row missing the required
    /// fields.
    public init?(record: FrickObjectRecord) {
        let f = record.value
        guard let callId = f["callId"],
              let userId = f["userId"],
              let deviceId = f["deviceId"],
              let joinedAt = f["joinedAt"] else { return nil }
        self.id = record.id
        self.callId = callId
        self.userId = userId
        self.deviceId = deviceId
        self.state = f["state"].flatMap(FrickCallParticipantState.init(rawValue:)) ?? .joined
        self.joinedAt = joinedAt
        self.leftAt = f["leftAt"]
        self.micEnabled = FrickCallParticipantRecord.parseBool(f["micEnabled"])
        self.cameraEnabled = FrickCallParticipantRecord.parseBool(f["cameraEnabled"])
        self.screenSharing = FrickCallParticipantRecord.parseBool(f["screenSharing"])
        self.speaking = f["speaking"].map { FrickCallParticipantRecord.parseBool($0) }
        self.networkQuality = f["networkQuality"].flatMap(FrickCallNetworkQuality.init(rawValue:))
    }

    private static func parseBool(_ raw: String?) -> Bool {
        guard let raw else { return false }
        return raw == "true" || raw == "1"
    }
}

/// A short-lived, participant-scoped credential the client presents to the
/// media plane to join the actual media session. Mirrors TS `CallMediaGrant`.
public struct FrickCallMediaGrant: Sendable, Equatable {
    public let callId: String
    public let mediaSessionId: String
    public let userId: String
    public let deviceId: String
    public let token: String
    public let expiresAt: String
    public let connection: [String: String]?

    public init(
        callId: String,
        mediaSessionId: String,
        userId: String,
        deviceId: String,
        token: String,
        expiresAt: String,
        connection: [String: String]? = nil
    ) {
        self.callId = callId
        self.mediaSessionId = mediaSessionId
        self.userId = userId
        self.deviceId = deviceId
        self.token = token
        self.expiresAt = expiresAt
        self.connection = connection
    }

    init?(map: [String: FrickMsgPackValue]) {
        guard let callId = map["callId"]?.stringValue,
              let mediaSessionId = map["mediaSessionId"]?.stringValue,
              let userId = map["userId"]?.stringValue,
              let deviceId = map["deviceId"]?.stringValue,
              let token = map["token"]?.stringValue,
              let expiresAt = map["expiresAt"]?.stringValue else { return nil }
        self.callId = callId
        self.mediaSessionId = mediaSessionId
        self.userId = userId
        self.deviceId = deviceId
        self.token = token
        self.expiresAt = expiresAt
        if let conn = map["connection"]?.mapValue {
            self.connection = conn.reduce(into: [String: String]()) { acc, kv in
                acc[kv.key] = kv.value.stringValue
            }
        } else {
            self.connection = nil
        }
    }
}

/// Partial media-state mutation for the `setMediaState` command (FR-82).
/// Mirrors TS `CallMediaStatePatch`.
public struct FrickCallMediaStatePatch: Sendable, Equatable {
    public let micEnabled: Bool?
    public let cameraEnabled: Bool?
    public let screenSharing: Bool?

    public init(micEnabled: Bool? = nil, cameraEnabled: Bool? = nil, screenSharing: Bool? = nil) {
        self.micEnabled = micEnabled
        self.cameraEnabled = cameraEnabled
        self.screenSharing = screenSharing
    }

    func asMsgPack() -> FrickMsgPackValue {
        var pairs: [(FrickMsgPackValue, FrickMsgPackValue)] = []
        if let micEnabled { pairs.append((.string("micEnabled"), .bool(micEnabled))) }
        if let cameraEnabled { pairs.append((.string("cameraEnabled"), .bool(cameraEnabled))) }
        if let screenSharing { pairs.append((.string("screenSharing"), .bool(screenSharing))) }
        return .map(pairs)
    }
}

// MARK: - Command

/// Discriminated set of call control-plane commands. Mirrors the TS
/// `CallCommandOp` union; `asMsgPack()` produces the exact `command` body the
/// wire contract expects (`op` plus the per-op fields).
public enum FrickCallCommand: Sendable, Equatable {
    case create(conversationId: String, inviteeUserIds: [String], kind: FrickCallKind? = nil, regionHint: String? = nil)
    case join(callId: String)
    case accept(callId: String)
    case leave(callId: String)
    case end(callId: String)
    case setMediaState(callId: String, media: FrickCallMediaStatePatch)

    /// The `op` discriminator name.
    public var op: String {
        switch self {
        case .create: return "create"
        case .join: return "join"
        case .accept: return "accept"
        case .leave: return "leave"
        case .end: return "end"
        case .setMediaState: return "setMediaState"
        }
    }

    func asMsgPack() -> FrickMsgPackValue {
        switch self {
        case let .create(conversationId, inviteeUserIds, kind, regionHint):
            var pairs: [(FrickMsgPackValue, FrickMsgPackValue)] = [
                (.string("op"), .string("create")),
                (.string("conversationId"), .string(conversationId)),
                (.string("inviteeUserIds"), .array(inviteeUserIds.map { .string($0) })),
            ]
            if let kind { pairs.append((.string("kind"), .string(kind.rawValue))) }
            if let regionHint { pairs.append((.string("regionHint"), .string(regionHint))) }
            return .map(pairs)
        case let .join(callId):
            return .map([(.string("op"), .string("join")), (.string("callId"), .string(callId))])
        case let .accept(callId):
            return .map([(.string("op"), .string("accept")), (.string("callId"), .string(callId))])
        case let .leave(callId):
            return .map([(.string("op"), .string("leave")), (.string("callId"), .string(callId))])
        case let .end(callId):
            return .map([(.string("op"), .string("end")), (.string("callId"), .string(callId))])
        case let .setMediaState(callId, media):
            return .map([
                (.string("op"), .string("setMediaState")),
                (.string("callId"), .string(callId)),
                (.string("media"), media.asMsgPack()),
            ])
        }
    }
}

// MARK: - Result

/// The server's reply to a `CallCommand`. Mirrors TS `CallCommandResultPayload`:
/// `requestId` echoes the request and each field is populated for the commands
/// that produce it (create → `room`/`invites`; join → `room`/`participant`/
/// `mediaGrant`; accept → `invite`; leave/end → `room`; setMediaState →
/// `participant`).
public struct FrickCallCommandResult: Sendable, Equatable {
    public let requestId: String
    public let op: String
    public let room: FrickCallRoomRecord?
    public let invites: [FrickCallInviteRecord]
    public let participant: FrickCallParticipantRecord?
    public let mediaGrant: FrickCallMediaGrant?
    public let invite: FrickCallInviteRecord?

    public init(
        requestId: String,
        op: String,
        room: FrickCallRoomRecord? = nil,
        invites: [FrickCallInviteRecord] = [],
        participant: FrickCallParticipantRecord? = nil,
        mediaGrant: FrickCallMediaGrant? = nil,
        invite: FrickCallInviteRecord? = nil
    ) {
        self.requestId = requestId
        self.op = op
        self.room = room
        self.invites = invites
        self.participant = participant
        self.mediaGrant = mediaGrant
        self.invite = invite
    }

    init(map: [String: FrickMsgPackValue]) {
        self.requestId = map["requestId"]?.stringValue ?? ""
        self.op = map["op"]?.stringValue ?? ""
        self.room = map["room"]?.mapValue.flatMap(FrickCallRoomRecord.init(map:))
        self.invites = (map["invites"]?.arrayValue ?? []).compactMap {
            $0.mapValue.flatMap(FrickCallInviteRecord.init(map:))
        }
        self.participant = map["participant"]?.mapValue.flatMap(FrickCallParticipantRecord.init(map:))
        self.mediaGrant = map["mediaGrant"]?.mapValue.flatMap(FrickCallMediaGrant.init(map:))
        self.invite = map["invite"]?.mapValue.flatMap(FrickCallInviteRecord.init(map:))
    }
}

// MARK: - Object type names

/// Object type names the call client reads (mirrors the server schema and the
/// TS `CALL_*_TYPE` constants).
public enum FrickCallObjectType {
    public static let room = "CallRoom"
    public static let invite = "CallInvite"
    public static let participant = "CallParticipant"
}

// MARK: - Result shapes for the ergonomic helpers

/// Resolved `create` result: the freshly-created room (state `ringing`) and the
/// per-invitee invites. Mirrors TS `CreateCallResult`.
public struct FrickCreateCallResult: Sendable, Equatable {
    public let room: FrickCallRoomRecord
    public let invites: [FrickCallInviteRecord]
}

/// Resolved `join` result: the (now `active`) room, your participant record,
/// and the media grant to present to the media layer. Mirrors TS
/// `JoinCallResult`.
public struct FrickJoinCallResult: Sendable, Equatable {
    public let room: FrickCallRoomRecord
    public let participant: FrickCallParticipantRecord
    public let mediaGrant: FrickCallMediaGrant
}

/// Errors raised by the call helpers when a result is missing a field the
/// command was supposed to produce (a malformed server reply).
public enum FrickCallError: Error, Equatable, Sendable {
    case missingResultField(op: String, field: String)
}

/// FR-80 — ergonomic call helpers over `FrickSyncSocket.callCommand`. Thin
/// mirrors of the TS `createCall`/`joinCall`/`acceptCall`/`leaveCall`/`endCall`/
/// `setCallMediaState` free functions: they issue a `CallCommand` and unwrap
/// the typed `CallCommandResult` the matching command produces. They never
/// mutate call state locally — the control plane is server-authoritative and
/// the records arrive over sync (drive an observable `FrickCallState` off that).
public extension FrickSyncSocket {
    /// Create a call in `conversationId`, inviting `inviteeUserIds` (must
    /// exclude the caller). Resolves with the room + per-invitee invites.
    func createCall(
        conversationId: String,
        inviteeUserIds: [String],
        kind: FrickCallKind? = nil,
        regionHint: String? = nil
    ) async throws -> FrickCreateCallResult {
        let result = try await callCommand(.create(
            conversationId: conversationId,
            inviteeUserIds: inviteeUserIds,
            kind: kind,
            regionHint: regionHint
        ))
        guard let room = result.room else {
            throw FrickCallError.missingResultField(op: "create", field: "room")
        }
        return FrickCreateCallResult(room: room, invites: result.invites)
    }

    /// Join a call you were invited to. Resolves with the active room, your
    /// participant record, and the media grant. Joining implicitly accepts a
    /// still-ringing invite.
    func joinCall(callId: String) async throws -> FrickJoinCallResult {
        let result = try await callCommand(.join(callId: callId))
        guard let room = result.room else {
            throw FrickCallError.missingResultField(op: "join", field: "room")
        }
        guard let participant = result.participant else {
            throw FrickCallError.missingResultField(op: "join", field: "participant")
        }
        guard let mediaGrant = result.mediaGrant else {
            throw FrickCallError.missingResultField(op: "join", field: "mediaGrant")
        }
        return FrickJoinCallResult(room: room, participant: participant, mediaGrant: mediaGrant)
    }

    /// Accept a ringing invite without joining yet.
    func acceptCall(callId: String) async throws -> FrickCallInviteRecord {
        let result = try await callCommand(.accept(callId: callId))
        guard let invite = result.invite else {
            throw FrickCallError.missingResultField(op: "accept", field: "invite")
        }
        return invite
    }

    /// Leave a call. The last active participant leaving auto-ends the call.
    func leaveCall(callId: String) async throws -> FrickCallRoomRecord {
        let result = try await callCommand(.leave(callId: callId))
        guard let room = result.room else {
            throw FrickCallError.missingResultField(op: "leave", field: "room")
        }
        return room
    }

    /// End a call. Only the creator may end it explicitly.
    func endCall(callId: String) async throws -> FrickCallRoomRecord {
        let result = try await callCommand(.end(callId: callId))
        guard let room = result.room else {
            throw FrickCallError.missingResultField(op: "end", field: "room")
        }
        return room
    }

    /// Update your own media state (mic / camera / screen-share) — the FR-82
    /// call-presence surface. Resolves with the updated participant record.
    @discardableResult
    func setCallMediaState(
        callId: String,
        media: FrickCallMediaStatePatch
    ) async throws -> FrickCallParticipantRecord {
        let result = try await callCommand(.setMediaState(callId: callId, media: media))
        guard let participant = result.participant else {
            throw FrickCallError.missingResultField(op: "setMediaState", field: "participant")
        }
        return participant
    }
}
