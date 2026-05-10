import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

public enum FrickMode: String, Sendable {
    case system
    case light
    case dark
}

public enum FrickDensity: String, Sendable {
    case compact
    case regular
    case comfortable
}

public enum FrickBrand: String, Sendable {
    case frick
    case frickenChat
}

public enum FrickIconPack: String, Sendable {
    case native
    case frick
}

public struct FrickDesignContext: Sendable {
    public var mode: FrickMode
    public var density: FrickDensity
    public var brand: FrickBrand
    public var iconPack: FrickIconPack

    public init(
        mode: FrickMode = .system,
        density: FrickDensity = .regular,
        brand: FrickBrand = .frick,
        iconPack: FrickIconPack = .native
    ) {
        self.mode = mode
        self.density = density
        self.brand = brand
        self.iconPack = iconPack
    }
}

public enum FrickTokens {
    public enum Spacing {
        public static let none: CGFloat = 0
        public static let extraSmall: CGFloat = 4
        public static let small: CGFloat = 8
        public static let medium: CGFloat = 16
        public static let large: CGFloat = 24
        public static let extraLarge: CGFloat = 32
    }

    public enum Radius {
        public static let control: CGFloat = 12
        public static let surface: CGFloat = 16
        public static let bubble: CGFloat = 20
        public static let pill: CGFloat = 999
    }

    public enum Colors {
        public static let background = Color.frickDynamic(light: FrickColorComponents(red: 0.9647, green: 0.9843, blue: 0.9725), dark: FrickColorComponents(red: 0.0471, green: 0.0667, blue: 0.0627))
        public static let surface = Color.frickDynamic(light: FrickColorComponents(red: 1.0000, green: 1.0000, blue: 1.0000), dark: FrickColorComponents(red: 0.0902, green: 0.1294, blue: 0.1216))
        public static let surfaceRaised = Color.frickDynamic(light: FrickColorComponents(red: 0.9059, green: 0.9412, blue: 0.9255), dark: FrickColorComponents(red: 0.1255, green: 0.1804, blue: 0.1647))
        public static let text = Color.frickDynamic(light: FrickColorComponents(red: 0.0667, green: 0.0980, blue: 0.0902), dark: FrickColorComponents(red: 0.9333, green: 0.9725, blue: 0.9529))
        public static let textMuted = Color.frickDynamic(light: FrickColorComponents(red: 0.3176, green: 0.3961, blue: 0.3725), dark: FrickColorComponents(red: 0.6588, green: 0.7333, blue: 0.7059))
        public static let border = Color.frickDynamic(light: FrickColorComponents(red: 0.8431, green: 0.8980, blue: 0.8745), dark: FrickColorComponents(red: 0.2078, green: 0.2863, blue: 0.2627))
        public static let accent = Color.frickDynamic(light: FrickColorComponents(red: 0.0863, green: 0.5176, blue: 0.3882), dark: FrickColorComponents(red: 0.0863, green: 0.5176, blue: 0.3882))
        public static let accentForeground = Color.frickDynamic(light: FrickColorComponents(red: 1.0000, green: 1.0000, blue: 1.0000), dark: FrickColorComponents(red: 1.0000, green: 1.0000, blue: 1.0000))
        public static let success = Color.frickDynamic(light: FrickColorComponents(red: 0.0863, green: 0.5176, blue: 0.3882), dark: FrickColorComponents(red: 0.0863, green: 0.5176, blue: 0.3882))
        public static let warning = Color.frickDynamic(light: FrickColorComponents(red: 0.6039, green: 0.3922, blue: 0.0000), dark: FrickColorComponents(red: 0.6039, green: 0.3922, blue: 0.0000))
        public static let danger = Color.frickDynamic(light: FrickColorComponents(red: 0.6196, green: 0.2000, blue: 0.3098), dark: FrickColorComponents(red: 0.6196, green: 0.2000, blue: 0.3098))
        public static let info = Color.frickDynamic(light: FrickColorComponents(red: 0.3216, green: 0.4745, blue: 0.8627), dark: FrickColorComponents(red: 0.3216, green: 0.4745, blue: 0.8627))
        public static let chatIncoming = Color.frickDynamic(light: FrickColorComponents(red: 1.0000, green: 1.0000, blue: 1.0000), dark: FrickColorComponents(red: 0.1255, green: 0.1804, blue: 0.1647))
        public static let chatOutgoing = Color.frickDynamic(light: FrickColorComponents(red: 0.7843, green: 0.9686, blue: 0.9098), dark: FrickColorComponents(red: 0.0549, green: 0.2078, blue: 0.1765))
    }

    public enum Typography {
        public static let heading = Font.system(size: 28, weight: .bold, design: .rounded)
        public static let body = Font.system(size: 15, weight: .regular, design: .default)
        public static let label = Font.system(size: 13, weight: .semibold, design: .default)
        public static let mono = Font.system(size: 13, weight: .regular, design: .monospaced)
    }

    public enum Component {
        public static let buttonHeight: CGFloat = 40
        public static let textFieldHeight: CGFloat = 40
        public static let chatBubblePaddingX: CGFloat = 16
        public static let chatBubblePaddingY: CGFloat = 8
        public static let avatarSize: CGFloat = 40
    }
}

public enum FrickIconName: String, Sendable {
    case actionSend = "paperplane.fill"
    case actionReload = "arrow.clockwise"
    case actionAdd = "plus"
    case actionDetails = "info.circle"
    case navigationBack = "chevron.left"
    case navigationThreads = "tray.fill"
    case statusLive = "antenna.radiowaves.left.and.right"
    case chatMessage = "message.fill"
    case chatAttachment = "paperclip"
    case callVideo = "video.fill"
    case workspaceSettings = "gearshape"
    case themeLight = "sun.max"
    case themeDark = "moon"
}

private struct FrickColorComponents {
    let red: Double
    let green: Double
    let blue: Double

    var color: Color {
        Color(red: red, green: green, blue: blue)
    }

    #if canImport(UIKit)
    var uiColor: UIColor {
        UIColor(red: red, green: green, blue: blue, alpha: 1)
    }
    #elseif canImport(AppKit)
    var nsColor: NSColor {
        NSColor(red: red, green: green, blue: blue, alpha: 1)
    }
    #endif
}

private extension Color {
    static func frickDynamic(light: FrickColorComponents, dark: FrickColorComponents) -> Color {
        #if canImport(UIKit)
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark.uiColor : light.uiColor
        })
        #elseif canImport(AppKit)
        Color(NSColor(name: nil) { appearance in
            let match = appearance.bestMatch(from: [.darkAqua, .aqua])
            return match == .darkAqua ? dark.nsColor : light.nsColor
        })
        #else
        light.color
        #endif
    }
}
