import FrickDesign
import FrickSwift
import Observation
import SwiftUI

enum AuthMode: String, CaseIterable {
    case login
    case signUp
}

enum NewThreadKind: String, CaseIterable, Identifiable {
    case direct
    case group

    var id: String { rawValue }

    var title: String {
        switch self {
        case .direct: "Direct"
        case .group: "Group"
        }
    }

    var wireKind: String {
        switch self {
        case .direct: "dm"
        case .group: "group"
        }
    }
}

private let defaultConversationId = "conversation-general"
private let workspaceDestinations = [
    FrickWorkspaceDestination(id: "chat", title: "Chat", icon: .chatMessage),
    FrickWorkspaceDestination(id: "files", title: "Files", icon: .paperclip, isEnabled: false, badge: "Soon"),
    FrickWorkspaceDestination(id: "calls", title: "Calls", icon: .callVideo, isEnabled: false, badge: "Soon"),
    FrickWorkspaceDestination(id: "admin", title: "Admin", icon: .settings, isEnabled: false, badge: "Soon"),
]

@MainActor
@Observable
final class FoundationModel {
    var users: [UserDTO] = []
    var conversations: [ConversationDTO] = []
    var roomMembers: [RoomMemberDTO] = []
    var messages: [FrickStreamEvent] = []
    var selectedConversationId = defaultConversationId
    var selectedDestination = "chat"
    var isInspectorPresented = false
    var newThreadTitle = ""
    var newThreadKind: NewThreadKind = .direct
    var newThreadParticipantIds: [String] = []
    var threadError: String?
    var isCreatingThread = false
    var draft = ""
    var status = "Signed out"
    var currentSession: FrickSession?
    var authMode: AuthMode = .login
    var displayName = ""
    var handle = ""
    var password = ""
    var authError: String?
    var isAuthenticating = false

    @ObservationIgnored
    private let client = FrickClient()
    @ObservationIgnored
    private let deviceId = "ios-demo-device"
    @ObservationIgnored
    private let replicaId = "ios-demo"
    @ObservationIgnored
    var socket: FrickSyncSocket?
    @ObservationIgnored
    private var socketStatusTask: Task<Void, Never>?
    @ObservationIgnored
    private var socketEventsTask: Task<Void, Never>?
    @ObservationIgnored
    private var subscribedConversationId: String?

    var syncStatus: FrickSyncStatus = .initial

    var title: String {
        guard let selectedConversation else {
            return "Foundation General"
        }
        return title(for: selectedConversation)
    }

    var selectedConversation: ConversationDTO? {
        conversations.first(where: { $0.id == selectedConversationId })
    }

    var selectedMembers: [RoomMemberDTO] {
        members(for: selectedConversationId)
    }

    var availableThreadParticipants: [UserDTO] {
        users
            .filter { $0.id != currentSession?.userId }
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }

    var isCreateThreadDisabled: Bool {
        if isCreatingThread {
            return true
        }
        switch newThreadKind {
        case .direct:
            return newThreadParticipantIds.count != 1
        case .group:
            return newThreadTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                newThreadParticipantIds.isEmpty
        }
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
            async let nextRoomMembers = client.fetchRoomMembers()
            let loadedUsers = try await nextUsers
            let loadedConversations = try await nextConversations
            let loadedRoomMembers = try await nextRoomMembers
            guard currentSession?.sessionToken == sessionToken, selectedConversationId == requestedConversationId else {
                return
            }
            users = loadedUsers
            conversations = loadedConversations
            roomMembers = loadedRoomMembers
            ensureSelectedConversationExists()
            let resolvedConversationId = selectedConversationId
            // Cold-start: HTTP fetch the existing page so the UI is responsive
            // before the WS delta stream kicks in.
            let initial = try await client.fetchMessages(
                conversationId: resolvedConversationId,
                readUserId: session.userId
            )
            guard currentSession?.sessionToken == sessionToken, selectedConversationId == resolvedConversationId else {
                return
            }
            messages = initial

            // Bring up the live WebSocket subscription for this conversation.
            try await ensureSocket()
            await resubscribeMessages(for: resolvedConversationId)
            status = "Live"
        } catch is CancellationError {
            // Normal when signing out or replacing the active stream.
        } catch {
            if currentSession?.sessionToken == sessionToken, selectedConversationId == requestedConversationId {
                status = error.localizedDescription
            }
        }
    }

    private func ensureSocket() async throws {
        if socket != nil { return }
        let opened = try client.connectSync()
        socket = opened
        socketStatusTask = Task { [weak self] in
            for await update in await opened.statusUpdates() {
                await self?.applySyncStatus(update)
            }
        }
        socketEventsTask = Task { [weak self] in
            do {
                for try await event in await opened.events {
                    await self?.handleInbound(event)
                }
            } catch {
                // Stream closed; status updates will reflect the state.
            }
        }
    }

    private func applySyncStatus(_ update: FrickSyncStatus) {
        syncStatus = update
    }

    private func handleInbound(_ event: FrickInboundEvent) async {
        switch event {
        case .delta(_, let events, _):
            messages = mergeStreamEvents(messages, events)
        case .status(let value):
            syncStatus = value
        default:
            break
        }
    }

    private func resubscribeMessages(for conversationId: String) async {
        guard let socket else { return }
        if subscribedConversationId == conversationId { return }
        subscribedConversationId = conversationId
        do {
            try await socket.subscribe(stream: "MessageStream", key: conversationId)
        } catch {
            status = "Subscribe failed: \(error.localizedDescription)"
        }
    }

    private func mergeStreamEvents(_ base: [FrickStreamEvent], _ incoming: [FrickStreamEvent]) -> [FrickStreamEvent] {
        var byId = Dictionary(uniqueKeysWithValues: base.map { ($0.eventId, $0) })
        for event in incoming {
            byId[event.eventId] = event
        }
        return byId.values.sorted { lhs, rhs in
            if lhs.streamId != rhs.streamId {
                return lhs.streamId < rhs.streamId
            }
            return lhs.sequence < rhs.sequence
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
            async let nextRoomMembers = client.fetchRoomMembers()
            let loadedUsers = try await nextUsers
            let loadedConversations = try await nextConversations
            let loadedRoomMembers = try await nextRoomMembers
            guard currentSession?.sessionToken == sessionToken else {
                return
            }
            users = loadedUsers
            conversations = loadedConversations
            roomMembers = loadedRoomMembers
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

    private func messagePayload(senderId: String, body: String) -> [String: String] {
        [
            "messageId": "message-\(UUID().uuidString)",
            "senderId": senderId,
            "body": body,
            "createdAt": ISO8601DateFormatter().string(from: Date()),
        ]
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
        let payload = messagePayload(senderId: session.userId, body: body)
        do {
            if let socket, syncStatus.state == .connected {
                try await socket.append(
                    stream: "MessageStream",
                    key: requestedConversationId,
                    event: "MessageSent",
                    payload: payload
                )
            } else {
                // Fall back to the HTTP append when the socket is not live.
                try await client.sendMessage(conversationId: requestedConversationId, body: body)
            }
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

    @discardableResult
    func createThread() async -> String? {
        let title = newThreadTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isCreateThreadDisabled else {
            threadError = newThreadKind == .direct ? "Choose one person." : "Choose people and a title."
            return nil
        }
        guard currentSession != nil else {
            status = "Sign in"
            return nil
        }

        isCreatingThread = true
        threadError = nil
        status = "Creating thread"
        defer { isCreatingThread = false }

        do {
            let created = try await client.createConversation(
                title: newThreadKind == .group ? title : nil,
                kind: newThreadKind.wireKind,
                participantUserIds: newThreadParticipantIds
            )
            conversations = mergedConversations(conversations, adding: created.conversation)
            roomMembers = mergedRoomMembers(roomMembers, adding: created.members)
            selectedConversationId = created.conversation.id
            newThreadTitle = ""
            newThreadParticipantIds = []
            messages = []
            draft = ""
            status = "Thread created"
            return created.conversation.id
        } catch {
            threadError = "Could not create thread."
            status = error.localizedDescription
            return nil
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
        subscribedConversationId = nil
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
        Task { [socket, socketStatusTask, socketEventsTask] in
            await socket?.close()
            socketStatusTask?.cancel()
            socketEventsTask?.cancel()
        }
        socket = nil
        socketStatusTask = nil
        socketEventsTask = nil
        subscribedConversationId = nil
        syncStatus = .initial
        client.signOut()
        currentSession = nil
        users = []
        conversations = []
        roomMembers = []
        messages = []
        selectedConversationId = defaultConversationId
        selectedDestination = "chat"
        isInspectorPresented = false
        newThreadTitle = ""
        newThreadKind = .direct
        newThreadParticipantIds = []
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

    func title(for conversation: ConversationDTO) -> String {
        if let title = conversation.title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return title
        }
        let threadMembers = members(for: conversation.id)
        if conversation.kind == "dm" {
            let peer = threadMembers.first(where: { $0.userId != currentSession?.userId }) ?? threadMembers.first
            return peer.map { displayName(for: $0.userId) } ?? "Direct message"
        }
        let participantNames = threadMembers
            .filter { $0.userId != currentSession?.userId }
            .prefix(3)
            .map { displayName(for: $0.userId) }
        return participantNames.isEmpty ? titleFromConversationId(conversation.id) : participantNames.joined(separator: ", ")
    }

    func members(for conversationId: String) -> [RoomMemberDTO] {
        roomMembers
            .filter { $0.conversationId == conversationId }
            .sorted { lhs, rhs in
                if lhs.role != rhs.role {
                    return lhs.role == "owner"
                }
                return displayName(for: lhs.userId).localizedCaseInsensitiveCompare(displayName(for: rhs.userId)) == .orderedAscending
            }
    }

    func toggleNewThreadParticipant(_ userId: String) {
        threadError = nil
        switch newThreadKind {
        case .direct:
            newThreadParticipantIds = newThreadParticipantIds.first == userId ? [] : [userId]
        case .group:
            if newThreadParticipantIds.contains(userId) {
                newThreadParticipantIds.removeAll { $0 == userId }
            } else {
                newThreadParticipantIds.append(userId)
            }
        }
    }

    func normalizeNewThreadSelection() {
        threadError = nil
        if newThreadKind == .direct, newThreadParticipantIds.count > 1 {
            newThreadParticipantIds = Array(newThreadParticipantIds.prefix(1))
        }
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
    @State private var model = FoundationModel()
    private let bottomMessageAnchor = "bottom-message-anchor"

    var body: some View {
        @Bindable var model = model

        Group {
            if model.currentSession == nil {
                NavigationStack {
                    AuthGate(model: model)
                        .navigationTitle(model.title)
                }
            } else {
                FrickWorkspaceShell(
                    destinations: workspaceDestinations,
                    selection: $model.selectedDestination,
                    inspectorPresented: $model.isInspectorPresented
                ) { destination in
                    if destination.id == "chat" {
                        ChatScene(model: model, bottomMessageAnchor: bottomMessageAnchor)
                    } else {
                        NavigationStack {
                            PlaceholderDestination(destination: destination)
                                .navigationTitle(destination.title)
                        }
                    }
                } inspector: {
                    ChatInspector(model: model)
                }
            }
        }
        .frickDesignContext(FrickDesignContext(density: .comfortable, brand: .frickenChat))
    }
}

private struct AuthGate: View {
    @Bindable var model: FoundationModel

    var body: some View {
        FrickStack(spacing: .lg) {
            FrickStack(spacing: .xs) {
                FrickLabel("Frick foundation")
                FrickHeading("Foundation General")
            }

            FrickSegmentedPicker("Authentication mode", selection: $model.authMode) {
                Text("Log in").tag(AuthMode.login)
                Text("Sign up").tag(AuthMode.signUp)
            }
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

                    FrickButton(model.authToggleTitle, variant: .ghost) {
                        if model.authMode == .signUp {
                            model.useLoginMode()
                        } else {
                            model.useSignUpMode()
                        }
                    }

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
    let model: FoundationModel
    let bottomMessageAnchor: String
    @State private var preferredCompactColumn: NavigationSplitViewColumn = .sidebar

    var body: some View {
        FrickListDetailShell(
            preferredCompactColumn: $preferredCompactColumn,
            sidebarTitle: "Threads"
        ) {
            ThreadListView(
                model: model,
                onCreateThread: createThread,
                onSelectConversation: selectConversation
            )
            .toolbar {
                ThreadListToolbar(model: model)
            }
        } detail: {
            ChatDetailScene(model: model, bottomMessageAnchor: bottomMessageAnchor)
                .navigationTitle(model.title)
                .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func createThread() {
        Task {
            if await model.createThread() != nil {
                preferredCompactColumn = .detail
            }
        }
    }

    private func selectConversation(_ conversationId: String) {
        model.selectConversation(conversationId)
        preferredCompactColumn = .detail
    }
}

private struct ChatDetailScene: View {
    @Bindable var model: FoundationModel
    let bottomMessageAnchor: String

    var body: some View {
        ScrollViewReader { proxy in
            List {
                Section("Messages") {
                    ForEach(model.visibleMessages, id: \.eventId) { message in
                        FrickChatBubble(
                            message: FrickMessage(
                                id: message.eventId,
                                author: model.displayName(for: message.payload["senderId"] ?? ""),
                                body: message.payload["body"] ?? "",
                                timestamp: messageTimestamp(for: message),
                                isCurrentUser: model.isCurrentUser(message.payload["senderId"])
                            )
                        )
                        .listRowSeparator(.hidden)
                    }
                    if model.visibleMessages.isEmpty {
                        FrickLabel("No messages yet")
                            .frame(maxWidth: .infinity, alignment: .center)
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
            ChatDetailToolbar(model: model)
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
}

private struct ThreadListView: View {
    @Bindable var model: FoundationModel
    let onCreateThread: () -> Void
    let onSelectConversation: (String) -> Void

    var body: some View {
        List {
            threadSections
        }
    }

    @ViewBuilder
    private var threadSections: some View {
        Section("Create") {
            Picker("Thread type", selection: $model.newThreadKind) {
                ForEach(NewThreadKind.allCases) { kind in
                    Text(kind.title).tag(kind)
                }
            }
            .pickerStyle(.segmented)
            .onChange(of: model.newThreadKind) { _, _ in
                model.normalizeNewThreadSelection()
            }

            if model.newThreadKind == .group {
                FrickTextField("New thread", text: $model.newThreadTitle)
                    .submitLabel(.done)
                    .onSubmit(onCreateThread)
            }

            ForEach(model.availableThreadParticipants, id: \.id) { user in
                Button {
                    model.toggleNewThreadParticipant(user.id)
                } label: {
                    HStack(spacing: 12) {
                        FrickAvatar(name: user.displayName, size: 28)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(user.displayName)
                                .font(.body.weight(.semibold))
                            Text(user.id)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if model.newThreadParticipantIds.contains(user.id) {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.tint)
                        }
                    }
                }
                .buttonStyle(.plain)
            }

            FrickButton(model.newThreadKind == .direct ? "Start direct" : "Create group", variant: .secondary, size: .sm, action: onCreateThread)
                .disabled(model.isCreateThreadDisabled)

            if let threadError = model.threadError {
                FrickLabel(LocalizedStringKey(threadError))
            }
        }

        Section("Threads") {
            ForEach(model.conversations, id: \.id) { conversation in
                Button {
                    onSelectConversation(conversation.id)
                } label: {
                    FrickWorkspaceListItem(
                        title: model.title(for: conversation),
                        subtitle: conversation.kind.capitalized,
                        isSelected: conversation.id == model.selectedConversationId
                    )
                }
                .buttonStyle(.plain)
                .tag(conversation.id)
            }
        }
    }
}

private struct ThreadListToolbar: ToolbarContent {
    let model: FoundationModel

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            FrickIconButton(.actionReload, label: "Reload") {
                Task { await model.load() }
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            SyncStatusIndicator(status: model.syncStatus)
        }
        ToolbarItem(placement: .topBarTrailing) {
            AccountMenu(model: model)
        }
    }
}

private struct ChatDetailToolbar: ToolbarContent {
    let model: FoundationModel

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            FrickIconButton(.actionDetails, label: "Thread details") {
                model.isInspectorPresented.toggle()
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            FrickIconButton(.actionReload, label: "Reload") {
                Task { await model.load() }
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            SyncStatusIndicator(status: model.syncStatus)
        }
        ToolbarItem(placement: .topBarTrailing) {
            AccountMenu(model: model)
        }
    }
}

/// Small colored dot reflecting `FrickSyncStatus`. Tap to surface the last
/// error envelope (when present).
struct SyncStatusIndicator: View {
    let status: FrickSyncStatus
    @State private var isPresentingDetails = false

    private var color: Color {
        if status.lastError != nil { return .red }
        switch status.state {
        case .connected: return .green
        case .connecting, .reconnecting: return .yellow
        case .closed, .idle: return .red
        }
    }

    private var label: String {
        switch status.state {
        case .idle: return "Idle"
        case .connecting: return "Connecting"
        case .connected: return "Connected"
        case .reconnecting: return "Reconnecting"
        case .closed: return "Disconnected"
        }
    }

    var body: some View {
        Button {
            isPresentingDetails = true
        } label: {
            Circle()
                .fill(color)
                .frame(width: 10, height: 10)
                .overlay(
                    Circle().stroke(Color.primary.opacity(0.15), lineWidth: 0.5)
                )
        }
        .accessibilityLabel("Sync status: \(label)")
        .alert("Sync status", isPresented: $isPresentingDetails) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(detailsMessage)
        }
    }

    private var detailsMessage: String {
        var lines: [String] = ["State: \(label)"]
        if let lastError = status.lastError {
            lines.append("Last error: \(lastError)")
        }
        if status.pendingAppendCount > 0 {
            lines.append("Pending appends: \(status.pendingAppendCount)")
        }
        if let compat = status.schemaCompatibility {
            lines.append("Schema: \(compat.status)")
        }
        return lines.joined(separator: "\n")
    }
}

private struct AccountMenu: View {
    let model: FoundationModel

    var body: some View {
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

private struct ChatInspector: View {
    let model: FoundationModel

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
                ForEach(model.selectedMembers, id: \.id) { member in
                    FrickUserRow(
                        name: model.displayName(for: member.userId),
                        subtitle: member.role.capitalized,
                        isOnline: true
                    )
                }
                if model.selectedMembers.isEmpty {
                    FrickLabel("No members yet")
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

private func messageTimestamp(for message: FrickStreamEvent) -> String {
    guard
        let createdAt = message.payload["createdAt"],
        let date = ISO8601DateFormatter().date(from: createdAt)
    else {
        return ""
    }
    return date.formatted(date: .omitted, time: .shortened)
}

private func mergedConversations(_ conversations: [ConversationDTO], adding conversation: ConversationDTO) -> [ConversationDTO] {
    var byId = Dictionary(uniqueKeysWithValues: conversations.map { ($0.id, $0) })
    byId[conversation.id] = conversation
    return byId.values.sorted { lhs, rhs in
        (lhs.title ?? lhs.id).localizedCaseInsensitiveCompare(rhs.title ?? rhs.id) == .orderedAscending
    }
}

private func mergedRoomMembers(_ members: [RoomMemberDTO], adding newMembers: [RoomMemberDTO]) -> [RoomMemberDTO] {
    var byId = Dictionary(uniqueKeysWithValues: members.map { ($0.id, $0) })
    for member in newMembers {
        byId[member.id] = member
    }
    return byId.values.sorted { lhs, rhs in
        if lhs.conversationId != rhs.conversationId {
            return lhs.conversationId.localizedCaseInsensitiveCompare(rhs.conversationId) == .orderedAscending
        }
        if lhs.role != rhs.role {
            return lhs.role == "owner"
        }
        return lhs.userId.localizedCaseInsensitiveCompare(rhs.userId) == .orderedAscending
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
