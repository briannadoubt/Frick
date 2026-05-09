import FrickSwift
import SwiftUI

@MainActor
final class FoundationModel: ObservableObject {
    @Published var users: [UserDTO] = []
    @Published var conversations: [ConversationDTO] = []
    @Published var messages: [FrickStreamEvent] = []
    @Published var draft = ""
    @Published var status = "Idle"

    private let client = FrickClient()

    var title: String {
        conversations.first(where: { $0.id == "conversation-general" })?.title ?? "Foundation General"
    }

    func start() async {
        status = "Connecting"
        do {
            async let nextUsers = client.fetchUsers()
            async let nextConversations = client.fetchConversations()
            users = try await nextUsers
            conversations = try await nextConversations

            for try await nextMessages in client.streamMessages() {
                messages = nextMessages
                status = "Live"
            }
        } catch {
            status = error.localizedDescription
        }
    }

    func load() async {
        status = "Loading"
        do {
            async let nextUsers = client.fetchUsers()
            async let nextConversations = client.fetchConversations()
            async let nextMessages = client.fetchMessages()
            users = try await nextUsers
            conversations = try await nextConversations
            messages = try await nextMessages
            status = "Loaded"
        } catch {
            status = error.localizedDescription
        }
    }

    func send() async {
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else {
            return
        }
        draft = ""
        status = "Sending"
        do {
            try await client.sendMessage(body: body)
            status = "Sent"
        } catch {
            status = error.localizedDescription
        }
    }

    func displayName(for userId: String) -> String {
        users.first(where: { $0.id == userId })?.displayName ?? userId
    }
}

struct ContentView: View {
    @StateObject private var model = FoundationModel()

    var body: some View {
        NavigationStack {
            List {
                Section("Users") {
                    ForEach(model.users, id: \.id) { user in
                        HStack {
                            Text(initials(user.displayName))
                                .font(.caption.weight(.black))
                                .foregroundStyle(.blue)
                                .frame(width: 34, height: 34)
                                .background(.blue.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                            Text(user.displayName)
                                .font(.headline)
                        }
                    }
                }

                Section("Messages") {
                    ForEach(model.messages, id: \.eventId) { message in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(model.displayName(for: message.payload["senderId"] ?? ""))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Text(message.payload["body"] ?? "")
                                .font(.body)
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            .navigationTitle(model.title)
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 8) {
                    HStack(spacing: 8) {
                        TextField("Message the foundation", text: $model.draft)
                            .textFieldStyle(.roundedBorder)
                        Button {
                            Task { await model.send() }
                        } label: {
                            Image(systemName: "paperplane.fill")
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    Text(model.status)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                .padding()
                .background(.thinMaterial)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await model.load() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Reload")
                }
            }
            .task {
                await model.start()
            }
        }
    }

    private func initials(_ name: String) -> String {
        name
            .split(separator: " ")
            .compactMap(\.first)
            .prefix(2)
            .map(String.init)
            .joined()
            .uppercased()
    }
}
