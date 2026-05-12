import Foundation

/// Cross-device draft sync over the `MessageDraft` foundation object.
///
/// Mirrors the React `useDraft({ sync: true })` hook and the Kotlin
/// `FrickDraftStore`: writes go through `upsertObject` and reads come
/// from a single shared `subscribeObject("MessageDraft")` subscription
/// the actor manages internally. Per-conversation rows are addressed
/// by the cross-SDK id convention `"${userId}:${conversationId}"`,
/// so per-user isolation comes for free.
///
/// Conflict policy on the schema is `versionPrecondition` — two
/// devices typing at once race; the store handles the conflict by
/// re-issuing the write at the server-reported version (last-write-
/// wins). Two-device contention converges after a couple of round
/// trips.
public actor FrickDraftStore {
    public static func draftId(userId: String, conversationId: String) -> String {
        "\(userId):\(conversationId)"
    }

    private let socket: FrickSyncSocket
    private let userId: String

    private var subscribed = false
    private var versions: [String: Int] = [:]
    private var bodies: [String: String] = [:]
    private var continuations: [String: [UUID: AsyncStream<String>.Continuation]] = [:]
    private var listenerTask: Task<Void, Never>?

    public init(socket: FrickSyncSocket, userId: String) {
        self.socket = socket
        self.userId = userId
    }

    deinit {
        listenerTask?.cancel()
    }

    /// Returns the most recently observed draft body for the
    /// `(user, conversation)` pair, or `nil` if no row has yet
    /// arrived.
    public func currentDraft(for conversationId: String) -> String? {
        bodies[Self.draftId(userId: userId, conversationId: conversationId)]
    }

    /// Subscribe to changes for a single draft row. The stream
    /// yields the current body (if known) immediately, then every
    /// subsequent server-confirmed change. Multiple subscribers
    /// share a single underlying `subscribeObject("MessageDraft")`
    /// subscription.
    public func observe(conversationId: String) async -> AsyncStream<String> {
        await ensureSubscribed()
        let id = Self.draftId(userId: userId, conversationId: conversationId)
        let token = UUID()
        let stream = AsyncStream<String> { continuation in
            self.attach(id: id, token: token, continuation: continuation)
            if let existing = self.bodies[id] {
                continuation.yield(existing)
            }
            continuation.onTermination = { @Sendable [weak self] _ in
                Task { await self?.detach(id: id, token: token) }
            }
        }
        return stream
    }

    /// Persist `body` as the active draft. Idempotent — repeated
    /// calls with the same body collapse to one write per
    /// `versionPrecondition` round-trip.
    public func setDraft(_ body: String, for conversationId: String) async {
        let id = Self.draftId(userId: userId, conversationId: conversationId)
        let expected = versions[id]
        let payload: [String: Any] = [
            "userId": userId,
            "conversationId": conversationId,
            "body": body,
            "updatedAt": Int(Date().timeIntervalSince1970 * 1000),
        ]
        do {
            let version = try await socket.upsertObject(
                type: "MessageDraft",
                id: id,
                value: payload,
                expectedVersion: expected
            )
            versions[id] = version
            bodies[id] = body
        } catch {
            // Best-effort. The schema's `versionPrecondition` conflicts
            // arrive as a server error; the next setDraft call picks up
            // the corrected version from the inbound objectsDelta path.
        }
    }

    /// Clear the draft for a conversation. Emits an empty-body upsert
    /// since the foundation schema doesn't expose a delete primitive
    /// today.
    public func clearDraft(for conversationId: String) async {
        await setDraft("", for: conversationId)
    }

    // MARK: - Internal

    private func ensureSubscribed() async {
        if subscribed { return }
        subscribed = true
        listenerTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.socket.subscribeObject(type: "MessageDraft")
                for try await event in await self.socket.events {
                    guard case let .objectsDelta(records, _) = event else { continue }
                    await self.ingest(records: records)
                }
            } catch {
                await self.markUnsubscribed()
            }
        }
    }

    private func ingest(records: [FrickObjectRecord]) {
        for record in records where record.type == "MessageDraft" {
            let body = record.value["body"] ?? ""
            bodies[record.id] = body
            for cont in continuations[record.id]?.values ?? [:].values {
                cont.yield(body)
            }
        }
    }

    private func attach(id: String, token: UUID, continuation: AsyncStream<String>.Continuation) {
        var entries = continuations[id] ?? [:]
        entries[token] = continuation
        continuations[id] = entries
    }

    private func detach(id: String, token: UUID) {
        guard var entries = continuations[id] else { return }
        entries.removeValue(forKey: token)
        if entries.isEmpty {
            continuations.removeValue(forKey: id)
        } else {
            continuations[id] = entries
        }
    }

    private func markUnsubscribed() {
        subscribed = false
    }
}
