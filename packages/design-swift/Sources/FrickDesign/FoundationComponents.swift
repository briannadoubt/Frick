import SwiftUI

public enum FrickTextTone: Sendable {
    case primary
    case muted
    case accent
    case success
    case warning
    case danger
}

public struct FrickIcon: View, Sendable {
    public let name: FrickIconName
    public let size: CGFloat

    public init(_ name: FrickIconName, size: CGFloat = 18) {
        self.name = name
        self.size = size
    }

    public var body: some View {
        Image(systemName: name.rawValue)
            .font(.system(size: size, weight: .medium))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

public extension FrickIconName {
    static var add: FrickIconName { .actionAdd }
    static var alert: FrickIconName { .actionDetails }
    static var arrowDown: FrickIconName { .navigationBack }
    static var arrowLeft: FrickIconName { .navigationBack }
    static var arrowRight: FrickIconName { .navigationBack }
    static var arrowUp: FrickIconName { .navigationBack }
    static var call: FrickIconName { .callVideo }
    static var check: FrickIconName { .chatMessage }
    static var chevronDown: FrickIconName { .navigationBack }
    static var close: FrickIconName { .actionDetails }
    static var edit: FrickIconName { .chatMessage }
    static var menu: FrickIconName { .navigationThreads }
    static var microphone: FrickIconName { .callVideo }
    static var more: FrickIconName { .actionDetails }
    static var paperclip: FrickIconName { .chatAttachment }
    static var pause: FrickIconName { .callVideo }
    static var play: FrickIconName { .callVideo }
    static var search: FrickIconName { .navigationThreads }
    static var send: FrickIconName { .actionSend }
    static var settings: FrickIconName { .workspaceSettings }
    static var signal: FrickIconName { .statusLive }
    static var video: FrickIconName { .callVideo }
}

public struct FrickText: View, Sendable {
    public let text: LocalizedStringKey
    public let tone: FrickTextTone

    public init(_ text: LocalizedStringKey, tone: FrickTextTone = .primary) {
        self.text = text
        self.tone = tone
    }

    public var body: some View {
        Text(text)
            .font(FrickTypography.body)
            .foregroundStyle(color(for: tone))
    }
}

public struct FrickHeading: View, Sendable {
    public let text: LocalizedStringKey

    public init(_ text: LocalizedStringKey) {
        self.text = text
    }

    public var body: some View {
        Text(text)
            .font(FrickTypography.heading)
            .foregroundStyle(FrickPalette.text)
    }
}

public struct FrickLabel: View, Sendable {
    public let text: LocalizedStringKey

    public init(_ text: LocalizedStringKey) {
        self.text = text
    }

    public var body: some View {
        Text(text)
            .font(FrickTypography.label)
            .foregroundStyle(FrickPalette.textMuted)
    }
}

public struct FrickDivider: View, Sendable {
    public init() {}

    public var body: some View {
        Rectangle()
            .fill(FrickPalette.border)
            .frame(height: 1)
    }
}

public struct FrickSpacer: View, Sendable {
    public let size: FrickSpacingRole

    public init(_ size: FrickSpacingRole = .md) {
        self.size = size
    }

    public var body: some View {
        Color.clear.frame(width: FrickDesign.context.spacing(size), height: FrickDesign.context.spacing(size))
    }
}

public struct FrickSurface<Content: View>: View {
    public let padding: FrickSpacingRole
    public let content: Content

    public init(padding: FrickSpacingRole = .lg, @ViewBuilder content: () -> Content) {
        self.padding = padding
        self.content = content()
    }

    public var body: some View {
        content
            .padding(FrickDesign.context.spacing(padding))
            .background(FrickPalette.surface)
            .clipShape(RoundedRectangle(cornerRadius: FrickTokens.Radius.lg, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: FrickTokens.Radius.lg, style: .continuous)
                    .stroke(FrickPalette.border)
            }
    }
}

public struct FrickStack<Content: View>: View {
    public let spacing: FrickSpacingRole
    public let alignment: HorizontalAlignment
    public let content: Content

    public init(spacing: FrickSpacingRole = .md, alignment: HorizontalAlignment = .leading, @ViewBuilder content: () -> Content) {
        self.spacing = spacing
        self.alignment = alignment
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: alignment, spacing: FrickDesign.context.spacing(spacing)) { content }
    }
}

public struct FrickInline<Content: View>: View {
    public let spacing: FrickSpacingRole
    public let alignment: VerticalAlignment
    public let content: Content

    public init(spacing: FrickSpacingRole = .sm, alignment: VerticalAlignment = .center, @ViewBuilder content: () -> Content) {
        self.spacing = spacing
        self.alignment = alignment
        self.content = content()
    }

    public var body: some View {
        HStack(alignment: alignment, spacing: FrickDesign.context.spacing(spacing)) { content }
    }
}

public typealias FrickCluster<Content: View> = FrickInline<Content>

public struct FrickWorkspaceDestination: Identifiable, Hashable, Sendable {
    public let id: String
    public let title: String
    public let icon: FrickIconName
    public let isEnabled: Bool
    public let badge: String?

    public init(id: String, title: String, icon: FrickIconName, isEnabled: Bool = true, badge: String? = nil) {
        self.id = id
        self.title = title
        self.icon = icon
        self.isEnabled = isEnabled
        self.badge = badge
    }
}

public struct FrickWorkspaceShell<Content: View, Inspector: View>: View {
    public let destinations: [FrickWorkspaceDestination]
    public let selection: Binding<String>
    public let inspectorPresented: Binding<Bool>
    private let content: (FrickWorkspaceDestination) -> Content
    private let inspector: () -> Inspector

    public init(
        destinations: [FrickWorkspaceDestination],
        selection: Binding<String>,
        inspectorPresented: Binding<Bool> = .constant(false),
        @ViewBuilder content: @escaping (FrickWorkspaceDestination) -> Content,
        @ViewBuilder inspector: @escaping () -> Inspector
    ) {
        self.destinations = destinations
        self.selection = selection
        self.inspectorPresented = inspectorPresented
        self.content = content
        self.inspector = inspector
    }

    public var body: some View {
        let base = TabView(selection: selection) {
            ForEach(destinations) { destination in
                content(destination)
                    .tabItem {
                        Label(destination.title, systemImage: destination.icon.rawValue)
                    }
                    .tag(destination.id)
                    .disabled(!destination.isEnabled)
                    .modifier(FrickWorkspaceBadgeModifier(badge: destination.badge))
            }
        }
        .frickSidebarAdaptableTabViewStyle()

        // `.inspector` is unavailable on visionOS and tvOS — apply it only
        // where it exists so the shared workspace shell remains portable.
        #if os(visionOS) || os(tvOS)
        return base.background(FrickPalette.background)
        #else
        return base
            .inspector(isPresented: inspectorPresented) {
                inspector()
            }
            .background(FrickPalette.background)
        #endif
    }
}

private extension View {
    /// Applies `.sidebarAdaptable` where it exists (iOS 18 / macOS 15 / visionOS 2+),
    /// otherwise leaves the platform-default tab style so the shell still builds and
    /// runs on iOS 17 (graceful degradation to the standard tab bar).
    @ViewBuilder
    func frickSidebarAdaptableTabViewStyle() -> some View {
        if #available(iOS 18.0, macOS 15.0, tvOS 18.0, visionOS 2.0, *) {
            self.tabViewStyle(.sidebarAdaptable)
        } else {
            self
        }
    }
}

public struct FrickListDetailShell<Sidebar: View, Detail: View>: View {
    public let preferredCompactColumn: Binding<NavigationSplitViewColumn>
    public let columnVisibility: Binding<NavigationSplitViewVisibility>
    public let sidebarTitle: LocalizedStringKey
    public let sidebarIdealWidth: CGFloat
    public let sidebarMinWidth: CGFloat
    public let sidebarMaxWidth: CGFloat
    private let sidebar: () -> Sidebar
    private let detail: () -> Detail

    public init(
        preferredCompactColumn: Binding<NavigationSplitViewColumn>,
        columnVisibility: Binding<NavigationSplitViewVisibility> = .constant(.automatic),
        sidebarTitle: LocalizedStringKey,
        sidebarMinWidth: CGFloat = 280,
        sidebarIdealWidth: CGFloat = 320,
        sidebarMaxWidth: CGFloat = 420,
        @ViewBuilder sidebar: @escaping () -> Sidebar,
        @ViewBuilder detail: @escaping () -> Detail
    ) {
        self.preferredCompactColumn = preferredCompactColumn
        self.columnVisibility = columnVisibility
        self.sidebarTitle = sidebarTitle
        self.sidebarMinWidth = sidebarMinWidth
        self.sidebarIdealWidth = sidebarIdealWidth
        self.sidebarMaxWidth = sidebarMaxWidth
        self.sidebar = sidebar
        self.detail = detail
    }

    public var body: some View {
        NavigationSplitView(
            columnVisibility: columnVisibility,
            preferredCompactColumn: preferredCompactColumn
        ) {
            sidebar()
                .navigationTitle(sidebarTitle)
                .navigationSplitViewColumnWidth(
                    min: sidebarMinWidth,
                    ideal: sidebarIdealWidth,
                    max: sidebarMaxWidth
                )
        } detail: {
            detail()
        }
        .navigationSplitViewStyle(.balanced)
        .background(FrickPalette.background)
    }
}

public struct FrickWorkspaceListItem: View, Sendable {
    public let title: String
    public let subtitle: String?
    public let meta: String?
    public let isSelected: Bool

    public init(title: String, subtitle: String? = nil, meta: String? = nil, isSelected: Bool = false) {
        self.title = title
        self.subtitle = subtitle
        self.meta = meta
        self.isSelected = isSelected
    }

    public var body: some View {
        HStack(spacing: FrickTokens.Spacing.medium) {
            VStack(alignment: .leading, spacing: FrickTokens.Spacing.extraSmall) {
                Text(title)
                    .font(FrickTypography.body.weight(.semibold))
                    .foregroundStyle(FrickPalette.text)
                    .lineLimit(1)
                if let subtitle {
                    Text(subtitle)
                        .font(FrickTypography.label)
                        .foregroundStyle(FrickPalette.textMuted)
                        .lineLimit(1)
                }
                if let meta {
                    Text(meta)
                        .font(FrickTypography.label)
                        .foregroundStyle(FrickPalette.accent)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: FrickTokens.Spacing.small)
            if isSelected {
                FrickIcon(.check)
                    .foregroundStyle(FrickPalette.accent)
            }
        }
        .contentShape(Rectangle())
    }
}

private struct FrickWorkspaceBadgeModifier: ViewModifier {
    let badge: String?

    @ViewBuilder
    func body(content: Content) -> some View {
        #if os(tvOS)
        content
        #else
        if let badge {
            content.badge(badge)
        } else {
            content
        }
        #endif
    }
}

public struct FrickToolbar<Content: View>: View {
    public let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        HStack(spacing: FrickTokens.Spacing.sm) { content }
            .padding(.horizontal, FrickTokens.Spacing.md)
            .padding(.vertical, FrickTokens.Spacing.sm)
            .background(FrickPalette.surfaceRaised)
    }
}

public struct FrickScrollArea<Content: View>: View {
    public let axes: Axis.Set
    public let content: Content

    public init(_ axes: Axis.Set = .vertical, @ViewBuilder content: () -> Content) {
        self.axes = axes
        self.content = content()
    }

    public var body: some View {
        ScrollView(axes) { content }
            .scrollIndicators(.automatic)
    }
}

public enum FrickButtonVariant: Sendable {
    case primary
    case secondary
    case ghost
    case destructive
}

public enum FrickControlSize: Sendable {
    case sm
    case md
    case lg
}

public struct FrickButton: View, Sendable {
    public let title: String
    public let icon: FrickIconName?
    public let variant: FrickButtonVariant
    public let size: FrickControlSize
    private let action: () -> Void

    public init(_ title: String, icon: FrickIconName? = nil, variant: FrickButtonVariant = .primary, size: FrickControlSize = .md, action: @escaping () -> Void) {
        self.title = title
        self.icon = icon
        self.variant = variant
        self.size = size
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Label {
                Text(title)
            } icon: {
                if let icon {
                    FrickIcon(icon, size: 16)
                }
            }
            .font(font)
            .padding(.horizontal, horizontalPadding)
            .padding(.vertical, verticalPadding)
            .frame(minHeight: minHeight)
        }
        .buttonStyle(.plain)
        .foregroundStyle(foreground)
        .background(background)
        .clipShape(RoundedRectangle(cornerRadius: FrickTokens.Radius.md, style: .continuous))
    }

    private var minHeight: CGFloat {
        switch size {
        case .sm: 32
        case .md: 40
        case .lg: 48
        }
    }

    // Scales the button title with Dynamic Type (FR-102) by mapping each control
    // size to a relative text style instead of a fixed point size: sm 13pt →
    // `.footnote`, md 15pt → `.callout`, lg 17pt → `.body`.
    private var font: Font {
        switch size {
        case .sm: Font.system(.footnote, weight: .semibold)
        case .md: Font.system(.callout, weight: .semibold)
        case .lg: Font.system(.body, weight: .semibold)
        }
    }

    private var horizontalPadding: CGFloat {
        switch size {
        case .sm: FrickTokens.Spacing.sm
        case .md: FrickTokens.Spacing.md
        case .lg: FrickTokens.Spacing.lg
        }
    }

    private var verticalPadding: CGFloat {
        switch size {
        case .sm: FrickTokens.Spacing.xs
        case .md: FrickTokens.Spacing.sm
        case .lg: FrickTokens.Spacing.md
        }
    }

    private var foreground: Color {
        switch variant {
        case .primary, .destructive: FrickPalette.accentForeground
        case .secondary, .ghost: FrickPalette.text
        }
    }

    private var background: Color {
        switch variant {
        case .primary: FrickPalette.accent
        case .secondary: FrickPalette.surfaceRaised
        case .ghost: Color.clear
        case .destructive: FrickPalette.danger
        }
    }
}

public struct FrickIconButton: View, Sendable {
    public let icon: FrickIconName
    public let label: String
    private let action: () -> Void

    public init(_ icon: FrickIconName, label: String, action: @escaping () -> Void) {
        self.icon = icon
        self.label = label
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Label(label, systemImage: icon.rawValue)
                .labelStyle(.iconOnly)
                .font(.system(size: 18, weight: .medium))
                .padding(FrickTokens.Spacing.sm)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

public struct FrickTextField: View {
    public let title: String
    @Binding private var text: String

    public init(_ title: String, text: Binding<String>) {
        self.title = title
        self._text = text
    }

    public var body: some View {
        TextField(title, text: $text)
            .frickTextInputChrome()
    }
}

public struct FrickSecureField: View {
    public let title: String
    @Binding private var text: String

    public init(_ title: String, text: Binding<String>) {
        self.title = title
        self._text = text
    }

    public var body: some View {
        SecureField(title, text: $text)
            .frickTextInputChrome()
    }
}

public struct FrickTextArea: View {
    public let title: String
    @Binding private var text: String

    public init(_ title: String, text: Binding<String>) {
        self.title = title
        self._text = text
    }

    public var body: some View {
        #if os(tvOS)
        TextField(title, text: $text)
            .frame(minHeight: 88)
            .frickTextInputChrome(minHeight: 88)
        #else
        TextEditor(text: $text)
            .frame(minHeight: 88)
            .scrollContentBackground(.hidden)
            .frickTextInputChrome(minHeight: 88)
            .overlay(alignment: .topLeading) {
                if text.isEmpty {
                    Text(title)
                        .foregroundStyle(FrickPalette.textMuted)
                        .padding(FrickTokens.Spacing.sm)
                        .allowsHitTesting(false)
                }
            }
        #endif
    }
}

extension View {
    func frickTextInputChrome(minHeight: CGFloat = FrickTokens.Component.textFieldHeight) -> some View {
        self
            .font(FrickTypography.body)
            .foregroundStyle(FrickPalette.text)
            .tint(FrickPalette.accent)
            .padding(.horizontal, FrickTokens.Spacing.md)
            .padding(.vertical, FrickTokens.Spacing.sm)
            .frame(minHeight: minHeight)
            .background(
                FrickPalette.surfaceRaised,
                in: RoundedRectangle(cornerRadius: FrickTokens.Radius.pill, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: FrickTokens.Radius.pill, style: .continuous)
                    .stroke(FrickPalette.border.opacity(0.72), lineWidth: 1)
            }
    }
}

public struct FrickSegmentedPicker<Selection: Hashable, Content: View>: View {
    public let title: String
    @Binding private var selection: Selection
    private let content: Content

    public init(_ title: String, selection: Binding<Selection>, @ViewBuilder content: () -> Content) {
        self.title = title
        self._selection = selection
        self.content = content()
    }

    public var body: some View {
        Picker(title, selection: $selection) { content }
            .pickerStyle(.segmented)
    }
}

public struct FrickToggle: View {
    public let title: LocalizedStringKey
    @Binding private var isOn: Bool

    public init(_ title: LocalizedStringKey, isOn: Binding<Bool>) {
        self.title = title
        self._isOn = isOn
    }

    public var body: some View {
        Toggle(title, isOn: $isOn)
            .tint(FrickPalette.accent)
    }
}

public enum FrickStatusTone: Sendable {
    case neutral
    case success
    case warning
    case danger
    case info
}

public struct FrickBadge: View, Sendable {
    public let text: String
    public let tone: FrickStatusTone

    public init(_ text: String, tone: FrickStatusTone = .neutral) {
        self.text = text
        self.tone = tone
    }

    public var body: some View {
        Text(text)
            .font(FrickTypography.label)
            .foregroundStyle(toneColor)
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

public typealias FrickStatus = FrickBadge

public struct FrickPresence: View, Sendable {
    public let isOnline: Bool

    public init(isOnline: Bool) {
        self.isOnline = isOnline
    }

    public var body: some View {
        Circle()
            .fill(isOnline ? FrickPalette.success : FrickPalette.textMuted)
            .frame(width: 10, height: 10)
            .accessibilityLabel(isOnline ? "Online" : "Offline")
    }
}

public struct FrickProgress: View, Sendable {
    public let value: Double?

    public init(value: Double? = nil) {
        self.value = value
    }

    public var body: some View {
        ProgressView(value: value)
            .tint(FrickPalette.accent)
    }
}

public struct FrickToast: View, Sendable {
    public let message: String
    public let tone: FrickStatusTone

    public init(_ message: String, tone: FrickStatusTone = .neutral) {
        self.message = message
        self.tone = tone
    }

    public var body: some View {
        FrickSurface(padding: .md) {
            FrickInline {
                FrickIcon(tone == .danger ? .alert : .check)
                Text(message)
                    .font(FrickTypography.body)
            }
        }
    }
}

public struct FrickErrorState: View, Sendable {
    public let title: String
    public let message: String

    public init(title: String, message: String) {
        self.title = title
        self.message = message
    }

    public var body: some View {
        FrickStack(alignment: .center) {
            FrickIcon(.alert, size: 28)
                .foregroundStyle(FrickPalette.danger)
            FrickHeading(LocalizedStringKey(title))
            FrickText(LocalizedStringKey(message), tone: .muted)
        }
    }
}

public struct FrickEmptyState: View, Sendable {
    public let title: String
    public let message: String

    public init(title: String, message: String) {
        self.title = title
        self.message = message
    }

    public var body: some View {
        FrickStack(alignment: .center) {
            FrickIcon(.search, size: 28)
            FrickHeading(LocalizedStringKey(title))
            FrickText(LocalizedStringKey(message), tone: .muted)
        }
    }
}

public struct FrickMetric: View, Sendable {
    public let label: String
    public let value: String
    public let change: String?

    public init(label: String, value: String, change: String? = nil) {
        self.label = label
        self.value = value
        self.change = change
    }

    public var body: some View {
        FrickStack(spacing: .xs) {
            FrickLabel(LocalizedStringKey(label))
            Text(value)
                .font(.system(.title, design: .rounded, weight: .bold))
            if let change {
                FrickBadge(change, tone: .info)
            }
        }
    }
}

public struct FrickTimeline<Item: Identifiable, Row: View>: View {
    public let items: [Item]
    private let row: (Item) -> Row

    public init(items: [Item], @ViewBuilder row: @escaping (Item) -> Row) {
        self.items = items
        self.row = row
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: FrickTokens.Spacing.md) {
            ForEach(items) { item in
                HStack(alignment: .top, spacing: FrickTokens.Spacing.sm) {
                    Circle().fill(FrickPalette.accent).frame(width: 8, height: 8)
                    row(item)
                }
            }
        }
    }
}

public struct FrickTable<Data: RandomAccessCollection, Row: View>: View where Data.Element: Identifiable {
    public let data: Data
    private let row: (Data.Element) -> Row

    public init(_ data: Data, @ViewBuilder row: @escaping (Data.Element) -> Row) {
        self.data = data
        self.row = row
    }

    public var body: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(data) { item in
                row(item)
                FrickDivider()
            }
        }
    }
}

public typealias FrickDataGrid<Data: RandomAccessCollection, Row: View> = FrickTable<Data, Row> where Data.Element: Identifiable

public struct FrickDatePicker: View {
    public let title: String
    @Binding private var selection: Date

    public init(_ title: String, selection: Binding<Date>) {
        self.title = title
        self._selection = selection
    }

    public var body: some View {
        #if os(tvOS)
        FrickReadOnlyDateValue(
            title: title,
            value: selection.formatted(date: .abbreviated, time: .omitted)
        )
        #else
        DatePicker(title, selection: $selection, displayedComponents: .date)
        #endif
    }
}

public struct FrickTimePicker: View {
    public let title: String
    @Binding private var selection: Date

    public init(_ title: String, selection: Binding<Date>) {
        self.title = title
        self._selection = selection
    }

    public var body: some View {
        #if os(tvOS)
        FrickReadOnlyDateValue(
            title: title,
            value: selection.formatted(date: .omitted, time: .shortened)
        )
        #else
        DatePicker(title, selection: $selection, displayedComponents: .hourAndMinute)
        #endif
    }
}

#if os(tvOS)
private struct FrickReadOnlyDateValue: View {
    let title: String
    let value: String

    var body: some View {
        HStack {
            Text(title)
            Spacer()
            Text(value)
                .foregroundStyle(FrickPalette.textMuted)
        }
        .frickTextInputChrome()
    }
}
#endif

public struct FrickDateRangePicker<Content: View>: View {
    public let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        FrickInline { content }
    }
}

public struct FrickSparkline: View, Sendable {
    public let values: [Double]

    public init(values: [Double]) {
        self.values = values
    }

    public var normalizedValues: [Double] {
        guard let min = values.min(), let max = values.max(), min != max else {
            return values.map { _ in 0.5 }
        }
        return values.map { ($0 - min) / (max - min) }
    }

    public var body: some View {
        GeometryReader { proxy in
            Path { path in
                let points = normalizedValues
                guard let first = points.first else { return }
                let step = points.count > 1 ? proxy.size.width / CGFloat(points.count - 1) : 0
                path.move(to: CGPoint(x: 0, y: proxy.size.height * (1 - first)))
                for index in points.indices.dropFirst() {
                    path.addLine(to: CGPoint(x: CGFloat(index) * step, y: proxy.size.height * (1 - points[index])))
                }
            }
            .stroke(FrickPalette.accent, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
        }
        .frame(minHeight: 32)
    }
}

public typealias FrickChart = FrickSparkline

private func color(for tone: FrickTextTone) -> Color {
    switch tone {
    case .primary: FrickPalette.text
    case .muted: FrickPalette.textMuted
    case .accent: FrickPalette.accent
    case .success: FrickPalette.success
    case .warning: FrickPalette.warning
    case .danger: FrickPalette.danger
    }
}
