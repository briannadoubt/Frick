import SwiftUI

// MARK: - Phase-1 parity aliases
//
// These keep iOS naming aligned with the cross-platform Phase-1 component set
// (web/Android) where the SwiftUI package already shipped an idiomatic view
// under a slightly different name. They are additive and backward-compatible.

/// Cross-platform parity name for the app-level workspace shell.
/// On Apple platforms this is the `TabView`+`.sidebarAdaptable`+`.inspector` shell.
public typealias FrickAppShell = FrickWorkspaceShell

/// Cross-platform parity name for the segmented control.
public typealias FrickSegmentedControl = FrickSegmentedPicker

// MARK: - Feedback & State

/// Compact status pill pairing a semantic tone with a leading presence/status dot.
/// Parity with web/Android `FrickStatusChip`.
public struct FrickStatusChip: View, Sendable {
    public let text: String
    public let tone: FrickStatusTone

    public init(_ text: String, tone: FrickStatusTone = .neutral) {
        self.text = text
        self.tone = tone
    }

    public var body: some View {
        FrickInline(spacing: .xs) {
            Circle()
                .fill(toneColor)
                .frame(width: 8, height: 8)
            Text(text)
                .font(FrickTypography.label)
                .foregroundStyle(toneColor)
        }
        .padding(.horizontal, FrickTokens.Spacing.sm)
        .padding(.vertical, FrickTokens.Spacing.xs)
        .background(toneColor.opacity(0.12))
        .clipShape(Capsule())
    }

    private var toneColor: Color {
        switch tone {
        case .neutral: FrickPalette.textMuted
        case .success: FrickPalette.success
        case .warning: FrickPalette.warning
        case .danger: FrickPalette.danger
        case .info: FrickPalette.info
        }
    }
}

/// Parity name for the presence indicator dot.
public typealias FrickPresenceDot = FrickPresence

/// Determinate/indeterminate circular progress indicator.
/// Parity with web/Android `FrickProgressRing`. `value` in `0...1`; `nil` spins.
public struct FrickProgressRing: View, Sendable {
    public let value: Double?
    public let size: CGFloat
    public let lineWidth: CGFloat

    public init(value: Double? = nil, size: CGFloat = 36, lineWidth: CGFloat = 4) {
        self.value = value
        self.size = size
        self.lineWidth = lineWidth
    }

    public var body: some View {
        Group {
            if let value {
                ZStack {
                    Circle()
                        .stroke(FrickPalette.border, lineWidth: lineWidth)
                    Circle()
                        .trim(from: 0, to: CGFloat(min(max(value, 0), 1)))
                        .stroke(
                            FrickPalette.accent,
                            style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                        )
                        .rotationEffect(.degrees(-90))
                }
                .accessibilityValue(Text("\(Int((min(max(value, 0), 1)) * 100)) percent"))
            } else {
                ProgressView()
                    .progressViewStyle(.circular)
                    .tint(FrickPalette.accent)
            }
        }
        .frame(width: size, height: size)
    }
}

// MARK: - Communication

/// Wraps a row of reactions with horizontal cluster spacing.
/// Parity with web/Android `FrickReactionRow`.
public struct FrickReactionRow: View, Sendable {
    public struct Reaction: Identifiable, Equatable, Sendable {
        public let id: String
        public let value: String
        public let count: Int

        public init(value: String, count: Int = 1) {
            self.id = value
            self.value = value
            self.count = count
        }
    }

    public let reactions: [Reaction]

    public init(reactions: [Reaction]) {
        self.reactions = reactions
    }

    public var body: some View {
        FrickInline(spacing: .xs) {
            ForEach(reactions) { reaction in
                FrickReaction(reaction.value, count: reaction.count)
            }
        }
    }
}

/// Connection / signal-strength panel surface.
/// Parity with web/Android `FrickSignalPanel`.
public struct FrickSignalPanel: View, Sendable {
    public let title: String
    public let strength: Double
    public let detail: String?

    public init(title: String, strength: Double, detail: String? = nil) {
        self.title = title
        self.strength = strength
        self.detail = detail
    }

    public var body: some View {
        FrickSurface(padding: .md) {
            FrickStack(spacing: .sm) {
                FrickInline {
                    FrickIcon(.signal)
                    Text(title)
                        .font(FrickTypography.label)
                        .foregroundStyle(FrickPalette.text)
                    Spacer(minLength: FrickTokens.Spacing.sm)
                }
                FrickSignalIndicator(strength: strength)
                if let detail {
                    Text(detail)
                        .font(FrickTypography.label)
                        .foregroundStyle(FrickPalette.textMuted)
                }
            }
        }
    }
}

/// Single circular call-affordance button (start/end/toggle).
/// Parity with web/Android `FrickCallButton`.
public struct FrickCallButton: View, Sendable {
    public let icon: FrickIconName
    public let label: String
    public let tone: FrickStatusTone
    private let action: () -> Void

    public init(
        icon: FrickIconName = .call,
        label: String,
        tone: FrickStatusTone = .success,
        action: @escaping () -> Void
    ) {
        self.icon = icon
        self.label = label
        self.tone = tone
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            FrickIcon(icon, size: 22)
                .foregroundStyle(FrickPalette.accentForeground)
                .frame(width: 56, height: 56)
                .background(toneColor, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private var toneColor: Color {
        switch tone {
        case .neutral: FrickPalette.textMuted
        case .success: FrickPalette.success
        case .warning: FrickPalette.warning
        case .danger: FrickPalette.danger
        case .info: FrickPalette.info
        }
    }
}

// MARK: - Data Display

/// Parity name for the metric summary card.
public typealias FrickMetricCard = FrickMetric

/// Declarative table-column descriptor: title, optional width, alignment, and a
/// cell builder. Parity with web/Android `FrickColumn`. Use with `FrickDataTable`.
public struct FrickColumn<Row>: Identifiable {
    public let id: String
    public let title: String
    public let width: CGFloat?
    public let alignment: Alignment
    public let cell: (Row) -> AnyView

    public init<Cell: View>(
        _ title: String,
        width: CGFloat? = nil,
        alignment: Alignment = .leading,
        @ViewBuilder cell: @escaping (Row) -> Cell
    ) {
        self.id = title
        self.title = title
        self.width = width
        self.alignment = alignment
        self.cell = { AnyView(cell($0)) }
    }
}

/// A single rendered table cell with tokenized padding and alignment.
/// Parity with web/Android `FrickCell`.
public struct FrickCell<Content: View>: View {
    public let alignment: Alignment
    public let width: CGFloat?
    private let content: Content

    public init(alignment: Alignment = .leading, width: CGFloat? = nil, @ViewBuilder content: () -> Content) {
        self.alignment = alignment
        self.width = width
        self.content = content()
    }

    public var body: some View {
        content
            .font(FrickTypography.body)
            .foregroundStyle(FrickPalette.text)
            .padding(.horizontal, FrickTokens.Spacing.sm)
            .padding(.vertical, FrickTokens.Spacing.xs)
            .frame(width: width, alignment: alignment)
            .frame(maxWidth: width == nil ? .infinity : nil, alignment: alignment)
    }
}

/// Column-driven data table with a header row, semantic columns/cells, and
/// empty/error states. Scoped per Phase-1 depth (not a full grid engine).
public struct FrickDataTable<Data: RandomAccessCollection>: View where Data.Element: Identifiable {
    public let data: Data
    public let columns: [FrickColumn<Data.Element>]
    public let emptyMessage: String
    public let errorMessage: String?

    public init(
        _ data: Data,
        columns: [FrickColumn<Data.Element>],
        emptyMessage: String = "Nothing to show",
        errorMessage: String? = nil
    ) {
        self.data = data
        self.columns = columns
        self.emptyMessage = emptyMessage
        self.errorMessage = errorMessage
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            FrickDivider()
            if let errorMessage {
                FrickErrorState(title: "Couldn’t load", message: errorMessage)
                    .padding(FrickTokens.Spacing.lg)
            } else if data.isEmpty {
                FrickEmptyState(title: "Empty", message: emptyMessage)
                    .padding(FrickTokens.Spacing.lg)
            } else {
                ForEach(data) { row in
                    HStack(spacing: 0) {
                        ForEach(columns) { column in
                            FrickCell(alignment: column.alignment, width: column.width) {
                                column.cell(row)
                            }
                        }
                    }
                    FrickDivider()
                }
            }
        }
    }

    private var header: some View {
        HStack(spacing: 0) {
            ForEach(columns) { column in
                Text(column.title)
                    .font(FrickTypography.label)
                    .foregroundStyle(FrickPalette.textMuted)
                    .padding(.horizontal, FrickTokens.Spacing.sm)
                    .padding(.vertical, FrickTokens.Spacing.sm)
                    .frame(width: column.width, alignment: column.alignment)
                    .frame(maxWidth: column.width == nil ? .infinity : nil, alignment: column.alignment)
            }
        }
        .background(FrickPalette.surfaceRaised)
    }
}

// MARK: - Date & Time

/// Combined date + time picker mapping to the native control.
/// Parity with web/Android `FrickDateTimePicker`.
public struct FrickDateTimePicker: View {
    public let title: String
    @Binding private var selection: Date

    public init(_ title: String, selection: Binding<Date>) {
        self.title = title
        self._selection = selection
    }

    public var body: some View {
        DatePicker(title, selection: $selection, displayedComponents: [.date, .hourAndMinute])
    }
}
