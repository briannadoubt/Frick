import FrickDesign
import FrickSwift
import SwiftUI

enum AuthMode: String, CaseIterable {
    case login
    case signUp
}

private let defaultConversationId = "conversation-general"
private let workspaceDestinations = [
    FrickWorkspaceDestination(id: "chat", title: "Chat", icon: .chatMessage),
    FrickWorkspaceDestination(id: "files", title: "Files", icon: .paperclip, isEnabled: false, badge: "Soon"),
    FrickWorkspaceDestination(id: "calls", title: "Calls", icon: .callVideo, isEnabled: false, badge: "Soon"),
    FrickWorkspaceDestination(id: "admin", title: "Admin", icon: .settings, isEnabled: false, badge: "Soon"),
]

@MainActor
final class FoundationModel: ObservableObject {
    @Published var users: [UserDTO] = []
    @Published var conversations: [ConversationDTO] = []
    @Published var messages: [FrickStreamEvent] = []
    @Published var selectedConversationId = defaultConversationId
    @Published var selectedDestination = "chat"
    @Published var isInspectorPresented = false
    @Published var newThreadTitle = ""
    @Published var threadError: String?
    @Published var isCreatingThread = false
    @Published var draft = ""
    @Published var status = "Signed out"
    @Published var currentSession: FrickSession?
    @Published var authMode: AuthMode = .login
    @Published var displayName = ""
    @Published var handle = ""
    @Published var password = ""
    @Published var authError: String?
    @Published var isAuthenticating = false

    private let client = FrickClient()
    private let deviceId = "ios-demo-device"
    private let replicaId = "ios-demo"

    var title: String {
        selectedConversation?.title ?? "Foundation General"
    }

    var selectedConversation: ConversationDTO? {
        conversations.first(where: { $0.id == selectedConversationId })
    }

    var streamIdentity: String {
        "\(currentSession?.sessionToken ?? "signed-out"):\(selectedConversationId)"
    }

    var authenticatedUserLabel: String {
        guard let currentSession else {
            return "Signed out"
        }
        let name = currentSession.displayName ?? displayName(for: currentSession.userId)
        if let handle = currentSession.handle {
            return "\(name) @\(handle)"
        }
        return name
    }

    var visibleMessages: [FrickStreamEvent] {
        messages.filter { $0.streamId == selectedConversationId && $0.isVisibleChatMessage }
    }

    var authActionTitle: String {
        authMode == .signUp ? "Create person" : "Log in"
    }

    var authToggleTitle: String {
        authMode == .signUp ? "Have an account? Log in" : "New here? Sign up"
    }

    var isAuthSubmitDisabled: Bool {
        let normalizedHandle = handle.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedDisplayName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        return isAuthenticating ||
            normalizedHandle.isEmpty ||
            password.isEmpty ||
            (authMode == .signUp && normalizedDisplayName.isEmpty)
    }

    func start() async {
        guard let session = currentSession else {
            return
        }
        let sessionToken = session.sessionToken
        let requestedConversationId = selectedConversationId

        status = "Connecting"
        do {
            async let nextUsers = client.fetchUsers()
            async let nextConversations = client.fetchConversations()
            let loadedUsers = try await nextUsers
            let loadedConversations = try await nextConversations
            guard currentSession?.sessionToken == sessionToken, selectedConversationId == requestedConversationId else {
                return
            }
            users = loadedUsers
            conversations = loadedConversations
            ensureSelectedConversationExists()
            guard selectedConversationId == requestedConversationId else {
                return
            }

            for try await nextMessages in client.streamMessages(conversationId: requestedConversationId, readUserId: session.userId) {
                guard currentSession?.sessionToken == sessionToken, selectedConversationId == requestedConversationId else {
                    return
                }
                messages = nextMessages
                status = "Live"
            }
        } catch is CancellationError {
            // Normal when signing out or replacing the active stream.
        } catch {
            if currentSession?.sessionToken == sessionToken, selectedConversationId == requestedConversationId {
                status = error.localizedDescription
            }
        }
    }

    func load() async {
        guard let session = currentSession else {
            status = "Sign in"
            return
        }
        let sessionToken = session.sessionToken
        var statusConversationId = selectedConversationId

        status = "Loading"
        do {
            async let nextUsers = client.fetchUsers()
            async let nextConversations = client.fetchConversations()
            let loadedUsers = try await nextUsers
            let loadedConversations = try await nextConversations
            guard currentSession?.sessionToken == sessionToken else {
                return
            }
            users = loadedUsers
            conversations = loadedConversations
            ensureSelectedConversationExists()
            let resolvedConversationId = selectedConversationId
            statusConversationId = resolvedConversationId
            let loadedMessages = try await client.fetchMessages(conversationId: resolvedConversationId, readUserId: session.userId)
            guard currentSession?.sessionToken == sessionToken, selectedConversationId == resolvedConversationId else {
                return
            }
            messages = loadedMessages
            status = "Loaded"
        } catch {
            if currentSession?.sessionToken == sessionToken, selectedConversationId == statusConversationId {
                status = error.localizedDescription
            }
        }
    }

    func send() async {
        await send(body: draft)
    }

    func send(body rawBody: String) async {
        let body = rawBody.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else {
            return
        }
        guard let session = currentSession else {
            status = "Sign in"
            return
        }
        let sessionToken = session.sessionToken
        let requestedConversationId = selectedConversationId

        status = "Sending"
        do {
            try await client.sendMessage(conversationId: requestedConversationId, body: body)
            guard currentSession?.sessionToken == sessionToken, selectedConversationId == requestedConversationId else {
                return
            }
            if draft.trimmingCharacters(in: .whitespacesAndNewlines) == body {
                draft = ""
            }
            status = "Sent"
        } catch {
            guard currentSession?.sessionToken == sessionToken, selectedConversationId == requestedConversationId else {
                return
            }
            if draft.isEmpty {
                draft = body
            }
            status = error.localizedDescription
        }
    }

    func createThread() async {
        let title = newThreadTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else {
            return
        }
        guard currentSession != nil else {
            status = "Sign in"
            return
        }

        isCreatingThread = true
        threadError = nil
        status = "Creating thread"
        defer { isCreatingThread = false }

        do {
            let created = try await client.createConversation(title: title)
            conversations = mergedConversations(conversations, adding: created.conversation)
            selectedConversationId = created.conversation.id
            newThreadTitle = ""
            messages = []
            draft = ""
            status = "Thread created"
        } catch {
            threadError = "Could not create thread."
            status = error.localizedDescription
        }
    }

    func selectConversation(_ conversationId: String) {
        guard selectedConversationId != conversationId else {
            return
        }
        selectedConversationId = conversationId
        messages = []
        draft = ""
        threadError = nil
        status = "Loading"
    }

    func submitAuth() async {
        let normalizedHandle = handle.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedDisplayName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedHandle.isEmpty, !password.isEmpty else {
            authError = "Enter a handle and password."
            return
        }
        if authMode == .signUp, normalizedDisplayName.isEmpty {
            authError = "Enter a display name."
            return
        }

        isAuthenticating = true
        status = authMode == .signUp ? "Creating account" : "Signing in"
        authError = nil
        defer { isAuthenticating = false }

        do {
            let session: FrickSession
            switch authMode {
            case .login:
                session = try await client.login(
                    identity: normalizedHandle,
                    password: password,
                    deviceId: deviceId,
                    replicaId: replicaId,
                    platform: "ios"
                )
            case .signUp:
                session = try await client.signUp(
                    displayName: normalizedDisplayName,
                    handle: normalizedHandle,
                    password: password,
                    deviceId: deviceId,
                    replicaId: replicaId,
                    platform: "ios"
                )
            }
            currentSession = session
            password = ""
            status = "Signed in"
        } catch {
            authError = "Could not sign in. Check your handle and password."
            status = error.localizedDescription
        }
    }

    func logout() {
        client.signOut()
        currentSession = nil
        users = []
        conversations = []
        messages = []
        selectedConversationId = defaultConversationId
        selectedDestination = "chat"
        isInspectorPresented = false
        newThreadTitle = ""
        threadError = nil
        isCreatingThread = false
        draft = ""
        authMode = .login
        displayName = ""
        handle = ""
        password = ""
        authError = nil
        isAuthenticating = false
        status = "Signed out"
    }

    func createDemoAccount() async {
        authMode = .signUp
        let suffix = Int(Date().timeIntervalSince1970) % 1_000_000
        displayName = "New Frick Person"
        handle = "person\(suffix)"
        password = "foundation-\(suffix)"
        await submitAuth()
    }

    func useLoginMode() {
        authMode = .login
        authError = nil
    }

    func useSignUpMode() {
        authMode = .signUp
        authError = nil
    }

    func displayName(for userId: String) -> String {
        users.first(where: { $0.id == userId })?.displayName ?? userId
    }

    func isCurrentUser(_ userId: String?) -> Bool {
        userId == currentSession?.userId
    }

    private func ensureSelectedConversationExists() {
        guard !conversations.isEmpty else {
            selectedConversationId = defaultConversationId
            return
        }
        if conversations.contains(where: { $0.id == selectedConversationId }) {
            return
        }
        selectedConversationId = conversations.first(where: { $0.id == defaultConversationId })?.id ?? conversations[0].id
    }
}

struct ContentView: View {
    @StateObject private var model = FoundationModel()
    private let bottomMessageAnchor = "bottom-message-anchor"

    var body: some View {
        NavigationStack {
            if model.currentSession == nil {
                AuthGate(model: model)
                    .navigationTitle(model.title)
            } else {
                FrickWorkspaceShell(
                    destinations: workspaceDestinations,
                    selection: $model.selectedDestination,
                    inspectorPresented: $model.isInspectorPresented
                ) { destination in
                    if destination.id == "chat" {
                        ChatScene(model: model, bottomMessageAnchor: bottomMessageAnchor)
                    } else {
                        PlaceholderDestination(destination: destination)
                    }
                } inspector: {
                    ChatInspector(model: model)
                }
                .navigationTitle(model.title)
                .navigationBarTitleDisplayMode(.inline)
            }
        }
        .frickDesignContext(FrickDesignContext(density: .comfortable, brand: .frickenChat))
    }
}

private struct AuthGate: View {
    @ObservedObject var model: FoundationModel

    var body: some View {
        FrickStack(spacing: .lg) {
            FrickStack(spacing: .xs) {
                FrickLabel("Frick foundation")
                FrickHeading("Foundation General")
            }

            Picker("Authentication mode", selection: $model.authMode) {
                Text("Log in").tag(AuthMode.login)
                Text("Sign up").tag(AuthMode.signUp)
            }
            .pickerStyle(.segmented)
            .onChange(of: model.authMode) { _, _ in
                model.authError = nil
            }

            FrickSurface {
                FrickStack(spacing: .md) {
                    if model.authMode == .signUp {
                        FrickTextField("Display name", text: $model.displayName)
                            .textContentType(.name)
                    }

                    FrickTextField("Handle", text: $model.handle)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    FrickSecureField("Password", text: $model.password)
                        .textContentType(model.authMode == .signUp ? .newPassword : .password)
                        .submitLabel(.go)
                        .onSubmit {
                            Task { await model.submitAuth() }
                        }

                    if let authError = model.authError {
                        FrickLabel(LocalizedStringKey(authError))
                    } else {
                        FrickLabel(LocalizedStringKey(model.status))
                    }

                    FrickButton(model.authActionTitle, icon: .send) {
                        Task { await model.submitAuth() }
                    }
                    .disabled(model.isAuthSubmitDisabled)

                    Button(model.authToggleTitle) {
                        if model.authMode == .signUp {
                            model.useLoginMode()
                        } else {
                            model.useSignUpMode()
                        }
                    }
                    .buttonStyle(.plain)
                    .font(.caption.weight(.semibold))

                    FrickButton("Make demo person", variant: .secondary) {
                        Task { await model.createDemoAccount() }
                    }
                    .disabled(model.isAuthenticating)
                }
            }
        }
        .padding()
    }
}

private struct ChatScene: View {
    @ObservedObject var model: FoundationModel
    let bottomMessageAnchor: String

    var body: some View {
        ScrollViewReader { proxy in
            List {
                Section("Threads") {
                    FrickInline {
                        FrickTextField("New thread", text: $model.newThreadTitle)
                            .submitLabel(.done)
                            .onSubmit {
                                Task { await model.createThread() }
                            }
                        FrickButton("Create", variant: .secondary, size: .sm) {
                            Task { await model.createThread() }
                        }
                        .disabled(model.isCreatingThread || model.newThreadTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }

                    if let threadError = model.threadError {
                        FrickLabel(LocalizedStringKey(threadError))
                    }

                    ForEach(model.conversations, id: \.id) { conversation in
                        Button {
                            model.selectConversation(conversation.id)
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(conversation.title ?? titleFromConversationId(conversation.id))
                                        .font(.body.weight(.semibold))
                                    Text(conversation.kind.capitalized)
                                        .font(.caption.weight(.medium))
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if conversation.id == model.selectedConversationId {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(.tint)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }

                Section("Messages") {
                    ForEach(model.visibleMessages, id: \.eventId) { message in
                        FrickChatBubble(
                            message: FrickMessage(
                                id: message.eventId,
                                author: model.displayName(for: message.payload["senderId"] ?? ""),
                                body: message.payload["body"] ?? "",
                                timestamp: timestamp(for: message),
                                isCurrentUser: model.isCurrentUser(message.payload["senderId"])
                            )
                        )
                        .listRowSeparator(.hidden)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id(bottomMessageAnchor)
                }
            }
            .onChange(of: model.visibleMessages.last?.eventId) { _, _ in
                scrollToBottom(proxy)
            }
            .onChange(of: model.visibleMessages.count) { _, _ in
                scrollToBottom(proxy)
            }
            .task(id: model.streamIdentity) {
                await model.start()
                scrollToBottom(proxy)
            }
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 8) {
                FrickComposer(text: $model.draft) { body in
                    Task { await model.send(body: body) }
                }
                FrickLabel(LocalizedStringKey(model.status))
            }
            .padding()
            .background(.thinMaterial)
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    model.isInspectorPresented.toggle()
                } label: {
                    Image(systemName: "sidebar.right")
                }
                .accessibilityLabel("Thread details")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await model.load() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Reload")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Text(model.authenticatedUserLabel)
                    Button("Sign out", role: .destructive) {
                        model.logout()
                    }
                } label: {
                    Image(systemName: "person.crop.circle")
                }
                .accessibilityLabel("Account")
            }
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(50))
            withAnimation(.snappy(duration: 0.22)) {
                proxy.scrollTo(bottomMessageAnchor, anchor: .bottom)
            }
        }
    }

    private func timestamp(for message: FrickStreamEvent) -> String {
        guard
            let createdAt = message.payload["createdAt"],
            let date = ISO8601DateFormatter().date(from: createdAt)
        else {
            return ""
        }
        return date.formatted(date: .omitted, time: .shortened)
    }
}

private struct ChatInspector: View {
    @ObservedObject var model: FoundationModel

    var body: some View {
        FrickStack(spacing: .lg) {
            FrickStack(spacing: .xs) {
                FrickHeading("Thread Details")
                FrickLabel(LocalizedStringKey(model.title))
                FrickLabel(LocalizedStringKey(model.status))
            }

            FrickDivider()

            FrickStack(spacing: .sm) {
                FrickLabel("Members")
                ForEach(model.users, id: \.id) { user in
                    FrickUserRow(name: user.displayName, subtitle: "Synced user", isOnline: true)
                }
            }
        }
        .padding()
    }
}

private struct PlaceholderDestination: View {
    let destination: FrickWorkspaceDestination

    var body: some View {
        FrickStack(spacing: .md, alignment: .center) {
            FrickIcon(destination.icon, size: 28)
            FrickHeading(LocalizedStringKey(destination.title))
            FrickLabel("This workspace destination is ready for a real module.")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

private func mergedConversations(_ conversations: [ConversationDTO], adding conversation: ConversationDTO) -> [ConversationDTO] {
    var byId = Dictionary(uniqueKeysWithValues: conversations.map { ($0.id, $0) })
    byId[conversation.id] = conversation
    return byId.values.sorted { lhs, rhs in
        (lhs.title ?? lhs.id).localizedCaseInsensitiveCompare(rhs.title ?? rhs.id) == .orderedAscending
    }
}

private func titleFromConversationId(_ conversationId: String) -> String {
    conversationId
        .replacingOccurrences(of: "conversation-", with: "")
        .split { $0 == "-" || $0 == "_" || $0 == " " }
        .map { part in
            part.prefix(1).uppercased() + part.dropFirst()
        }
        .joined(separator: " ")
}
