#if canImport(Observation)
import Foundation
import Observation

/// Observable holder for the app's Frick authentication state.
///
/// `FrickClient` already owns *durable* session persistence: it auto-saves the
/// active `FrickSession` to its injected `FrickSessionPersisting` (the Keychain
/// by default) on every install, and auto-restores it on construction (see
/// `FrickClient.restorePersistedSession`). What it does NOT provide is an
/// *observable* auth-STATE surface for SwiftUI to gate on. This type fills that
/// gap: it wraps a `FrickClient`, mirrors the client's session into an
/// `@Observable` property, and exposes the auth verbs a sign-in UI calls.
///
/// Apps drop their own ad-hoc session persistence (UserDefaults blobs and the
/// like) and instead:
///
///   1. observe `session` / `isAuthenticated` to gate their UI, and
///   2. call `signIn` / `signUp` / `signOut` / `requestPasswordReset` /
///      `resetPassword`, which delegate to the underlying `FrickClient` and
///      ride its existing Keychain persistence — strictly more secure than a
///      UserDefaults reimplementation, and less code.
///
///     @main struct MyApp: App {
///         @State private var auth = FrickSessionManager(client: myClient)
///         var body: some Scene {
///             WindowGroup {
///                 if auth.isAuthenticated {
///                     RootView().environment(auth)
///                 } else {
///                     SignInView().environment(auth)
///                 }
///             }
///         }
///     }
///
/// The manager seeds `session` from `client.currentSession` at construction, so
/// a session the client auto-restored from the Keychain is reflected
/// immediately — the UI starts at the right gate on a warm launch without any
/// app-side restore code.
@MainActor
@Observable
public final class FrickSessionManager {

    /// The active Frick session, or `nil` when signed out. Views gate on this
    /// (or on `isAuthenticated`) — render the sign-in screen when it's `nil`.
    ///
    /// Kept in sync with `client.currentSession`: every verb that mints or
    /// clears a session on the client also updates this property, so observers
    /// re-render. Seeded from the client's auto-restored session at init.
    public private(set) var session: FrickSession?

    /// `true` when an auth network call (`signIn` / `signUp` / `signOut`) is in
    /// flight. Sign-in UIs disable their submit button while this is `true` to
    /// avoid duplicate submissions.
    public private(set) var isAuthenticating: Bool = false

    /// Convenience flag — `true` exactly when a session is held. Equivalent to
    /// `session != nil`; provided so views read as `if auth.isAuthenticated`.
    public var isAuthenticated: Bool { session != nil }

    /// The client every Frick call routes through. Exposed read-only so screens
    /// that need the client directly (a password-reset sheet, per-entity
    /// stores, sync-socket setup) don't have to go through a wrapper method
    /// here. Not part of the observable state.
    @ObservationIgnored public let client: FrickClient

    /// Wrap an existing `FrickClient`. The manager seeds `session` from
    /// `client.currentSession`, so a Keychain-restored session is reflected
    /// immediately. Persistence is the client's responsibility — this type
    /// never touches the Keychain (or any store) directly.
    public init(client: FrickClient) {
        self.client = client
        self.session = client.currentSession
    }

    // MARK: - Auth verbs

    /// Email/password sign-in. Delegates to `FrickClient.signInWithEmail`,
    /// which installs (and Keychain-persists) the returned session.
    public func signIn(email: String, password: String) async throws {
        isAuthenticating = true
        defer { isAuthenticating = false }

        let result = try await client.signInWithEmail(email: email, password: password)
        session = result.session
    }

    /// Email/password sign-up. Delegates to `FrickClient.signUpWithEmail`,
    /// which installs (and Keychain-persists) the returned session.
    public func signUp(email: String, password: String, displayName: String? = nil) async throws {
        isAuthenticating = true
        defer { isAuthenticating = false }

        let result = try await client.signUpWithEmail(
            email: email,
            password: password,
            displayName: displayName
        )
        session = result.session
    }

    /// Server-side logout — invalidates the session token, then clears local
    /// state (in the client, which purges the Keychain). Network errors are
    /// swallowed by `FrickClient.logout`: the user pressed Sign Out, they're
    /// getting signed out either way.
    public func signOut() async {
        isAuthenticating = true
        defer { isAuthenticating = false }

        await client.logout()
        session = nil
    }

    /// Kick off the email password-reset flow. Stateless — does not touch the
    /// active session. Delegates to `FrickClient.requestPasswordReset`.
    public func requestPasswordReset(email: String) async throws {
        try await client.requestPasswordReset(email: email)
    }

    /// Complete the email password-reset flow with the one-time token and a new
    /// password. Delegates to `FrickClient.resetPassword`. The server
    /// invalidates the user's sessions on success, so call `signIn` afterwards
    /// to re-establish one.
    public func resetPassword(token: String, newPassword: String) async throws {
        try await client.resetPassword(token: token, newPassword: newPassword)
    }
}
#endif
