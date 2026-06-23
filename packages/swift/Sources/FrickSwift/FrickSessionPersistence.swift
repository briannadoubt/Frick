import Foundation
import Security

/// Durable backing store for the active `FrickSession`. `FrickClient` reads
/// from this on construction (auto-restore) and writes to it whenever a
/// session is installed or cleared, so persistence is automatic for the app.
///
/// The default `FrickClient` uses `FrickKeychainSessionStore`; inject
/// `FrickInMemorySessionStore` in tests, or a custom conformer to back the
/// session with some other secure store.
public protocol FrickSessionPersisting: Sendable {
    /// Return the persisted session, or `nil` when nothing is stored.
    func load() throws -> FrickSession?

    /// Persist `session`, replacing any previously-stored value.
    func save(_ session: FrickSession) throws

    /// Remove any persisted session.
    func clear() throws
}


/// Non-durable `FrickSessionPersisting` that holds the session in memory only.
/// Useful for tests and previews where touching the real Keychain is
/// undesirable. Thread-safe.
public struct FrickInMemorySessionStore: FrickSessionPersisting {

    private final class Box: @unchecked Sendable {
        let lock = NSLock()
        var session: FrickSession?
    }

    private let box = Box()

    public init(initial: FrickSession? = nil) {
        box.session = initial
    }

    public func load() throws -> FrickSession? {
        box.lock.lock()
        defer { box.lock.unlock() }
        return box.session
    }

    public func save(_ session: FrickSession) throws {
        box.lock.lock()
        defer { box.lock.unlock() }
        box.session = session
    }

    public func clear() throws {
        box.lock.lock()
        defer { box.lock.unlock() }
        box.session = nil
    }
}


/// `FrickSessionPersisting` backed by the Keychain (a generic-password item).
///
/// Defaults to `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: the token
/// is readable by the app (and any extension sharing `accessGroup`) after the
/// first device unlock, but is never synced to iCloud Keychain and never
/// migrates to a restored/new device. Pass an `accessGroup` to share the
/// session with widgets / Siri / notification extensions — this requires a
/// matching `keychain-access-groups` entitlement on every target involved.
public struct FrickKeychainSessionStore: FrickSessionPersisting {

    public enum KeychainError: Error, Equatable, Sendable {
        case unexpectedStatus(OSStatus)
    }

    private let service: String
    private let account: String
    private let accessGroup: String?
    private let accessibility: String

    public init(
        service: String = "com.frick.session",
        account: String = "frick.session",
        accessGroup: String? = nil,
        accessibility: CFString = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    ) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
        self.accessibility = accessibility as String
    }

    private func baseQuery() -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        return query
    }

    public func load() throws -> FrickSession? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)

        switch status {
        case errSecSuccess:
            guard let data = item as? Data else {
                return nil
            }
            return try JSONDecoder().decode(FrickSession.self, from: data)

        case errSecItemNotFound:
            return nil

        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }

    public func save(_ session: FrickSession) throws {
        let data = try JSONEncoder().encode(session)
        let query = baseQuery()
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: accessibility as CFString
        ]

        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)

        switch updateStatus {
        case errSecSuccess:
            return

        case errSecItemNotFound:
            var addQuery = query
            addQuery[kSecValueData as String] = data
            addQuery[kSecAttrAccessible as String] = accessibility as CFString
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw KeychainError.unexpectedStatus(addStatus)
            }

        default:
            throw KeychainError.unexpectedStatus(updateStatus)
        }
    }

    public func clear() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }
}


extension FrickSession {

    /// True when `expiresAt` parses to a date at or before `now`. An
    /// unparseable timestamp is treated as NOT expired so an unrecognized
    /// format never locks a user out — the server stays the source of truth
    /// and rejects a genuinely-dead token on the next request.
    func isExpired(now: Date = Date()) -> Bool {
        guard let expiry = Self.parseTimestamp(expiresAt) else {
            return false
        }
        return expiry <= now
    }

    static func parseTimestamp(_ string: String) -> Date? {
        isoWithFraction.date(from: string) ?? isoPlain.date(from: string)
    }

    nonisolated(unsafe) private static let isoWithFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    nonisolated(unsafe) private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}
