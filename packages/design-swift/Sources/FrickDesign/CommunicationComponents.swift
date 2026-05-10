import SwiftUI

public struct FrickAvatar: View, Sendable {
    public let name: String
    public let image: Image?
    public let size: CGFloat

    public init(name: String, image: Image? = nil, size: CGFloat = 36) {
        self.name = name
        self.image = image
        self.size = size
    }

    public var initials: String {
        name.split(separator: " ")
            .prefix(2)
            .compactMap(\.first)
            .map(String.init)
            .joined()
            .uppercased()
    }

    public var body: some View {
        ZStack {
            Circle().fill(FrickPalette.surfaceRaised)
            if let image {
                image.resizable().scaledToFill()
            } else {
                Text(initials)
                    .font(.system(size: size * 0.34, weight: .semibold))
                    .foregroundStyle(FrickPalette.text)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityLabel(name)
    }
}

public struct FrickAvatarGroup: View, Sendable {
    public let names: [String]
    public let maxVisible: Int

    public init(names: [String], maxVisible: Int = 3) {
        self.names = names
        self.maxVisible = maxVisible
    }

    public var body: some View {
        HStack(spacing: -8) {
            ForEach(Array(names.prefix(maxVisible).enumerated()), id: \.offset) { _, name in
                FrickAvatar(name: name, size: 32)
                    .overlay(Circle().stroke(FrickPalette.surface, lineWidth: 2))
            }
            if names.count > maxVisible {
                Text("+\(names.count - maxVisible)")
                    .font(FrickTypography.label)
                    .frame(width: 32, height: 32)
                    .background(FrickPalette.surfaceRaised)
                    .clipShape(Circle())
            }
        }
    }
}

public struct FrickUserRow: View, Sendable {
    public let name: String
    public let subtitle: String?
    public let isOnline: Bool

    public init(name: String, subtitle: String? = nil, isOnline: Bool = false) {
        self.name = name
        self.subtitle = subtitle
        self.isOnline = isOnline
    }

    public var body: some View {
        FrickInline(spacing: .md) {
            ZStack(alignment: .bottomTrailing) {
                FrickAvatar(name: name)
                FrickPresence(isOnline: isOnline)
                    .background(Circle().fill(FrickPalette.surface))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(FrickTypography.body)
                if let subtitle {
                    Text(subtitle)
                        .font(FrickTypography.label)
                        .foregroundStyle(FrickPalette.textMuted)
                }
            }
        }
    }
}

public struct FrickMessage: Identifiable, Equatable, Sendable {
    public let id: String
    public let author: String
    public let body: String
    public let timestamp: String
    public let isCurrentUser: Bool

    public init(id: String, author: String, body: String, timestamp: String, isCurrentUser: Bool) {
        self.id = id
        self.author = author
        self.body = body
        self.timestamp = timestamp
        self.isCurrentUser = isCurrentUser
    }
}

public struct FrickChatBubble: View, Sendable {
    public let message: FrickMessage

    public init(message: FrickMessage) {
        self.message = message
    }

    public var body: some View {
        VStack(alignment: message.isCurrentUser ? .trailing : .leading, spacing: FrickTokens.Spacing.xs) {
            Text(message.body)
                .font(FrickTypography.body)
                .foregroundStyle(message.isCurrentUser ? FrickPalette.accentForeground : FrickPalette.text)
                .padding(FrickTokens.Spacing.md)
                .background(message.isCurrentUser ? FrickPalette.accent : FrickPalette.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: FrickTokens.Radius.lg, style: .continuous))
            Text(message.timestamp)
                .font(FrickTypography.label)
                .foregroundStyle(FrickPalette.textMuted)
        }
        .frame(maxWidth: .infinity, alignment: message.isCurrentUser ? .trailing : .leading)
    }
}

public struct FrickMessageList: View, Sendable {
    public let messages: [FrickMessage]

    public init(messages: [FrickMessage]) {
        self.messages = messages
    }

    public var body: some View {
        LazyVStack(spacing: FrickTokens.Spacing.md) {
            ForEach(messages) { message in
                FrickChatBubble(message: message)
            }
        }
        .padding(FrickTokens.Spacing.md)
    }
}

public struct FrickComposer: View {
    @Binding private var text: String
    @FocusState private var isTextFieldFocused: Bool
    private let onSend: (String) -> Void

    public init(text: Binding<String>, onSend: @escaping (String) -> Void) {
        self._text = text
        self.onSend = onSend
    }

    public var body: some View {
        HStack(spacing: FrickTokens.Spacing.sm) {
            TextField("Message", text: $text)
                .focused($isTextFieldFocused)
                .submitLabel(.send)
                .onSubmit(sendCurrentText)
                .frickTextInputChrome()
            Button {
                sendCurrentText()
            } label: {
                FrickIcon(.send, size: 18)
                    .foregroundStyle(FrickPalette.accentForeground)
                    .frame(width: FrickTokens.Component.textFieldHeight, height: FrickTokens.Component.textFieldHeight)
                    .background(FrickPalette.accent, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Send")
            .disabled(!canSend)
            .opacity(canSend ? 1 : 0.52)
        }
        .padding(FrickTokens.Spacing.sm)
        .background(FrickPalette.surface)
    }

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func sendCurrentText() {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else {
            return
        }
        onSend(body)
        text = ""
        Task { @MainActor in
            isTextFieldFocused = true
        }
    }
}

public struct FrickTypingIndicator: View, Sendable {
    public let names: [String]

    public init(names: [String]) {
        self.names = names
    }

    public var body: some View {
        FrickInline(spacing: .xs) {
            ProgressView().controlSize(.small)
            Text(label)
                .font(FrickTypography.label)
                .foregroundStyle(FrickPalette.textMuted)
        }
    }

    private var label: String {
        switch names.count {
        case 0: "Someone is typing"
        case 1: "\(names[0]) is typing"
        default: "\(names.prefix(2).joined(separator: ", ")) are typing"
        }
    }
}

public enum FrickReceiptState: Sendable {
    case sending
    case sent
    case delivered
    case read
}

public struct FrickReceipt: View, Sendable {
    public let state: FrickReceiptState

    public init(_ state: FrickReceiptState) {
        self.state = state
    }

    public var body: some View {
        FrickInline(spacing: .xs) {
            FrickIcon(icon)
            Text(label)
                .font(FrickTypography.label)
        }
        .foregroundStyle(FrickPalette.textMuted)
    }

    private var icon: FrickIconName {
        switch state {
        case .sending: .more
        case .sent, .delivered, .read: .check
        }
    }

    private var label: String {
        switch state {
        case .sending: "Sending"
        case .sent: "Sent"
        case .delivered: "Delivered"
        case .read: "Read"
        }
    }
}

public struct FrickReaction: View, Sendable {
    public let value: String
    public let count: Int

    public init(_ value: String, count: Int = 1) {
        self.value = value
        self.count = count
    }

    public var body: some View {
        Text("\(value) \(count)")
            .font(FrickTypography.label)
            .padding(.horizontal, FrickTokens.Spacing.sm)
            .padding(.vertical, FrickTokens.Spacing.xs)
            .background(FrickPalette.surfaceRaised)
            .clipShape(Capsule())
    }
}

public struct FrickSignalIndicator: View, Sendable {
    public let strength: Double

    public init(strength: Double) {
        self.strength = strength
    }

    public var body: some View {
        FrickInline(spacing: .xs) {
            FrickIcon(.signal)
            ProgressView(value: min(max(strength, 0), 1))
                .frame(width: 44)
        }
        .tint(FrickPalette.success)
    }
}

public struct FrickCallControls: View, Sendable {
    private let onToggleMute: () -> Void
    private let onToggleVideo: () -> Void
    private let onEnd: () -> Void

    public init(
        onToggleMute: @escaping () -> Void,
        onToggleVideo: @escaping () -> Void,
        onEnd: @escaping () -> Void
    ) {
        self.onToggleMute = onToggleMute
        self.onToggleVideo = onToggleVideo
        self.onEnd = onEnd
    }

    public var body: some View {
        FrickInline(spacing: .md) {
            FrickIconButton(.microphone, label: "Mute", action: onToggleMute)
            FrickIconButton(.video, label: "Video", action: onToggleVideo)
            FrickButton("End", icon: .call, variant: .destructive, action: onEnd)
        }
    }
}
