import SwiftUI

public enum FrickColorRole: Sendable {
    case background
    case surface
    case surfaceRaised
    case text
    case textMuted
    case border
    case accent
    case accentForeground
    case success
    case warning
    case danger
    case info
}

public enum FrickSpacingRole: Sendable {
    case xs
    case sm
    case md
    case lg
    case xl
    case xxl
}

public enum FrickRadiusRole: Sendable {
    case sm
    case md
    case lg
    case pill
}

public extension FrickDesignContext {
    func color(_ role: FrickColorRole) -> Color {
        switch role {
        case .background: FrickPalette.background
        case .surface: FrickPalette.surface
        case .surfaceRaised: FrickPalette.surfaceRaised
        case .text: FrickPalette.text
        case .textMuted: FrickPalette.textMuted
        case .border: FrickPalette.border
        case .accent: FrickPalette.accent
        case .accentForeground: FrickPalette.accentForeground
        case .success: FrickPalette.success
        case .warning: FrickPalette.warning
        case .danger: FrickPalette.danger
        case .info: FrickPalette.info
        }
    }

    func spacing(_ role: FrickSpacingRole) -> CGFloat {
        switch role {
        case .xs: FrickTokens.Spacing.extraSmall
        case .sm: FrickTokens.Spacing.small
        case .md: FrickTokens.Spacing.medium
        case .lg: FrickTokens.Spacing.large
        case .xl: FrickTokens.Spacing.extraLarge
        case .xxl: FrickTokens.Spacing.extraLarge
        }
    }

    func radius(_ role: FrickRadiusRole) -> CGFloat {
        switch role {
        case .sm: FrickTokens.Radius.control
        case .md: FrickTokens.Radius.control
        case .lg: FrickTokens.Radius.surface
        case .pill: FrickTokens.Radius.pill
        }
    }
}

public enum FrickPalette {
    public static let background = FrickTokens.Colors.background
    public static let surface = FrickTokens.Colors.surface
    public static let surfaceRaised = FrickTokens.Colors.surfaceRaised
    public static let text = FrickTokens.Colors.text
    public static let textMuted = FrickTokens.Colors.textMuted
    public static let border = FrickTokens.Colors.border
    public static let accent = FrickTokens.Colors.accent
    public static let accentForeground = FrickTokens.Colors.accentForeground
    public static let success = FrickTokens.Colors.success
    public static let warning = FrickTokens.Colors.warning
    public static let danger = FrickTokens.Colors.danger
    public static let info = FrickTokens.Colors.info
}

public enum FrickTypography {
    public static let heading = FrickTokens.Typography.heading
    public static let body = FrickTokens.Typography.body
    public static let label = FrickTokens.Typography.label
    public static let mono = FrickTokens.Typography.mono
}

public extension FrickTokens.Spacing {
    static var xs: CGFloat { extraSmall }
    static var sm: CGFloat { small }
    static var md: CGFloat { medium }
    static var lg: CGFloat { large }
    static var xl: CGFloat { extraLarge }
    static var xxl: CGFloat { extraLarge }
}

public extension FrickTokens.Radius {
    static var sm: CGFloat { control }
    static var md: CGFloat { control }
    static var lg: CGFloat { surface }
}

private struct FrickDesignContextKey: EnvironmentKey {
    static let defaultValue = FrickDesignContext()
}

public extension EnvironmentValues {
    var frickDesign: FrickDesignContext {
        get { self[FrickDesignContextKey.self] }
        set { self[FrickDesignContextKey.self] = newValue }
    }
}

public extension View {
    func frickDesignContext(_ context: FrickDesignContext) -> some View {
        environment(\.frickDesign, context)
    }
}
