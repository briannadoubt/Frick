import Foundation

/// Decoded shape of an inbound APNs push body produced by the Frick
/// server's `apns-adapter.ts`. The server encodes notifications as:
///
///     {
///       "aps": { "alert": { "title", "body" }, "sound": "default", "thread-id" },
///       "intent": "<intent-name>",
///       "deepLink": "<url>?...",
///       "...custom data": "..."
///     }
///
/// `FrickPushPayload` is the typed view of that JSON. Decode it from
/// the raw `userInfo` dictionary delivered by
/// `UNNotificationServiceExtension` / `UNUserNotificationCenter` and
/// hand it to a `FrickDeepLinkRouter` to resolve the matching screen.
///
/// Lives in its own file so apps that don't ship a Notification Service
/// Extension still link against a tiny surface; the wider FrickSwift
/// module stays push-agnostic.
public struct FrickPushPayload: Codable, Equatable, Sendable {
    public let intent: String
    public let title: String?
    public let body: String?
    public let threadId: String?
    public let deepLink: String?
    /// Free-form additional data the server included under the top
    /// level (everything except `aps`, `intent`, `deepLink`).
    public let data: [String: String]

    public init(
        intent: String,
        title: String? = nil,
        body: String? = nil,
        threadId: String? = nil,
        deepLink: String? = nil,
        data: [String: String] = [:]
    ) {
        self.intent = intent
        self.title = title
        self.body = body
        self.threadId = threadId
        self.deepLink = deepLink
        self.data = data
    }

    /// Decode a payload from the `userInfo` dictionary
    /// `UNUserNotificationCenter` hands the app. Returns nil for shapes
    /// we don't recognize (e.g. third-party pushes the framework didn't
    /// produce) so the caller can fall through to its own handling.
    public static func from(userInfo: [AnyHashable: Any]) -> FrickPushPayload? {
        guard let intent = userInfo["intent"] as? String else { return nil }
        let aps = userInfo["aps"] as? [String: Any] ?? [:]
        let alert = aps["alert"] as? [String: Any] ?? [:]
        var data: [String: String] = [:]
        for (key, value) in userInfo {
            guard let stringKey = key as? String else { continue }
            if stringKey == "aps" || stringKey == "intent" || stringKey == "deepLink" { continue }
            if let stringValue = value as? String {
                data[stringKey] = stringValue
            } else if let number = value as? NSNumber {
                data[stringKey] = number.stringValue
            }
        }
        return FrickPushPayload(
            intent: intent,
            title: alert["title"] as? String,
            body: alert["body"] as? String,
            threadId: aps["thread-id"] as? String,
            deepLink: userInfo["deepLink"] as? String,
            data: data
        )
    }
}

/// Resolves a `FrickPushPayload` to one of the app's typed routes. The
/// generic `Route` parameter is the app's own destination enum; the
/// router runs a small pattern-matching list keyed by the payload's
/// `intent` string plus optional deep-link prefix.
///
///     let router = FrickDeepLinkRouter<AppRoute>()
///         .on(intent: "message.new") { .conversation(id: $0.threadId ?? "general") }
///         .on(intent: "call.ringing") { .call(id: $0.data["callId"] ?? "") }
///     if let route = router.resolve(payload) { app.navigate(to: route) }
public struct FrickDeepLinkRouter<Route: Sendable>: Sendable {
    public typealias Resolver = @Sendable (FrickPushPayload) -> Route?

    private var entries: [(intent: String, resolve: Resolver)] = []
    private var fallback: Resolver?

    public init() {}

    public func on(intent: String, _ resolve: @escaping Resolver) -> Self {
        var copy = self
        copy.entries.append((intent: intent, resolve: resolve))
        return copy
    }

    public func fallback(_ resolve: @escaping Resolver) -> Self {
        var copy = self
        copy.fallback = resolve
        return copy
    }

    public func resolve(_ payload: FrickPushPayload) -> Route? {
        for entry in entries where entry.intent == payload.intent {
            if let route = entry.resolve(payload) { return route }
        }
        return fallback?(payload)
    }
}
