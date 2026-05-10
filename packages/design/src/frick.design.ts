import { alias, defineDesign } from "./define.js";

export const frickDesignDefinition = defineDesign({
  primitive: {
    unit: 4,
    space: {
      0: 0,
      1: 4,
      2: 8,
      3: 12,
      4: 16,
      5: 20,
      6: 24,
      8: 32,
      10: 40,
      12: 48,
      14: 56,
      16: 64,
    },
    radius: {
      1: 4,
      2: 8,
      3: 12,
      4: 16,
      5: 20,
      6: 24,
      pill: 999,
    },
    color: {
      mint: {
        50: "#ebfff8",
        100: "#c8f7e8",
        300: "#8ee8c9",
        500: "#54d8ac",
        700: "#168463",
        900: "#0e352d",
      },
      blue: {
        100: "#dce8ff",
        400: "#7da2ff",
        500: "#5279dc",
        800: "#203a77",
      },
      neutral: {
        0: "#ffffff",
        50: "#f6fbf8",
        100: "#e7f0ec",
        200: "#d7e5df",
        700: "#51655f",
        900: "#111917",
        950: "#0c1110",
      },
      red: {
        100: "#ffe1e7",
        700: "#9e334f",
      },
      amber: {
        100: "#fff2cc",
        700: "#9a6400",
      },
    },
    font: {
      family: {
        sans: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      },
      size: {
        caption: 12,
        label: 13,
        body: 15,
        title: 28,
        display: 56,
      },
      weight: {
        regular: 400,
        semibold: 650,
        bold: 800,
        black: 900,
      },
    },
    opacity: {
      disabled: 0.48,
      overlay: 0.72,
    },
    shadow: {
      soft: "0 14px 48px rgba(23, 54, 45, 0.12)",
    },
    gradient: {
      brandHero: "linear-gradient(135deg, #ebfff8 0%, #dce8ff 100%)",
    },
  },
  semantic: {
    spacing: {
      none: alias("primitive.space.0"),
      extraSmall: alias("primitive.space.1"),
      small: alias("primitive.space.2"),
      medium: alias("primitive.space.4"),
      large: alias("primitive.space.6"),
      extraLarge: alias("primitive.space.8"),
    },
    padding: {
      extraSmall: alias("semantic.spacing.extraSmall"),
      small: alias("semantic.spacing.small"),
      medium: alias("semantic.spacing.medium"),
      large: alias("semantic.spacing.large"),
    },
    corner: {
      control: alias("primitive.radius.3"),
      surface: alias("primitive.radius.4"),
      bubble: alias("primitive.radius.5"),
      pill: alias("primitive.radius.pill"),
    },
    color: {
      page: alias("primitive.color.neutral.50"),
      text: alias("primitive.color.neutral.900"),
      textMuted: alias("primitive.color.neutral.700"),
      surface: alias("primitive.color.neutral.0"),
      surfaceRaised: alias("primitive.color.neutral.100"),
      border: alias("primitive.color.neutral.200"),
      actionPrimary: alias("primitive.color.mint.700"),
      onActionPrimary: alias("primitive.color.neutral.0"),
      incomingBubble: alias("primitive.color.neutral.0"),
      outgoingBubble: alias("primitive.color.mint.100"),
      success: alias("primitive.color.mint.700"),
      warning: alias("primitive.color.amber.700"),
      danger: alias("primitive.color.red.700"),
      info: alias("primitive.color.blue.500"),
    },
    gradient: {
      brandHero: alias("primitive.gradient.brandHero"),
    },
    typography: {
      body: {
        family: alias("primitive.font.family.sans"),
        size: alias("primitive.font.size.body"),
        weight: alias("primitive.font.weight.regular"),
      },
      label: {
        family: alias("primitive.font.family.sans"),
        size: alias("primitive.font.size.label"),
        weight: alias("primitive.font.weight.semibold"),
      },
      title: {
        family: alias("primitive.font.family.sans"),
        size: alias("primitive.font.size.title"),
        weight: alias("primitive.font.weight.bold"),
      },
    },
  },
  density: {
    compact: {
      semantic: {
        spacing: {
          medium: alias("primitive.space.3"),
          large: alias("primitive.space.5"),
        },
      },
      component: {
        button: { height: alias("primitive.space.8") },
        textField: { height: alias("primitive.space.8") },
        avatar: { size: alias("primitive.space.8") },
      },
    },
    regular: {},
    comfortable: {
      semantic: {
        spacing: {
          medium: alias("primitive.space.5"),
          large: alias("primitive.space.8"),
        },
      },
      component: {
        button: { height: alias("primitive.space.12") },
        textField: { height: alias("primitive.space.12") },
        avatar: { size: alias("primitive.space.12") },
      },
    },
  },
  modes: {
    light: {},
    dark: {
      semantic: {
        color: {
          page: alias("primitive.color.neutral.950"),
          text: "#eef8f3",
          textMuted: "#a8bbb4",
          surface: "#17211f",
          surfaceRaised: "#202e2a",
          border: "#354943",
          incomingBubble: "#202e2a",
          outgoingBubble: alias("primitive.color.mint.900"),
        },
      },
    },
  },
  brands: {
    frick: {},
    frickenChat: {
      semantic: {
        color: {
          actionPrimary: alias("primitive.color.blue.500"),
          outgoingBubble: alias("primitive.color.blue.100"),
        },
      },
    },
  },
  component: {
    button: {
      height: alias("primitive.space.10"),
      radius: alias("semantic.corner.pill"),
      paddingX: alias("semantic.spacing.medium"),
      background: alias("semantic.color.actionPrimary"),
      foreground: alias("semantic.color.onActionPrimary"),
    },
    textField: {
      height: alias("primitive.space.10"),
      radius: alias("semantic.corner.pill"),
      paddingX: alias("semantic.spacing.medium"),
      background: alias("semantic.color.surface"),
      foreground: alias("semantic.color.text"),
      font: alias("semantic.typography.body"),
    },
    chatBubble: {
      paddingX: alias("semantic.spacing.medium"),
      paddingY: alias("semantic.spacing.small"),
      radius: alias("semantic.corner.bubble"),
      incomingBackground: alias("semantic.color.incomingBubble"),
      outgoingBackground: alias("semantic.color.outgoingBubble"),
    },
    avatar: {
      size: alias("primitive.space.10"),
      radius: alias("semantic.corner.pill"),
    },
    surface: {
      radius: alias("semantic.corner.surface"),
      background: alias("semantic.color.surface"),
      border: alias("semantic.color.border"),
      shadow: alias("primitive.shadow.soft"),
    },
    iconButton: {
      icon: alias("icon.action.send"),
    },
  },
  icons: {
    "action.send": {
      web: { family: "lucide", name: "Send" },
      ios: { family: "sf", name: "paperplane.fill" },
      android: { family: "material", name: "Send" },
      fallback: { family: "frick", name: "send" },
    },
    "action.reload": {
      web: { family: "lucide", name: "RefreshCw" },
      ios: { family: "sf", name: "arrow.clockwise" },
      android: { family: "material", name: "Refresh" },
      fallback: { family: "frick", name: "reload" },
    },
    "action.add": {
      web: { family: "lucide", name: "Plus" },
      ios: { family: "sf", name: "plus" },
      android: { family: "material", name: "Add" },
      fallback: { family: "frick", name: "add" },
    },
    "action.details": {
      web: { family: "lucide", name: "Info" },
      ios: { family: "sf", name: "info.circle" },
      android: { family: "material", name: "Info" },
      fallback: { family: "frick", name: "details" },
    },
    "navigation.back": {
      web: { family: "lucide", name: "ArrowLeft" },
      ios: { family: "sf", name: "chevron.left" },
      android: { family: "material", name: "ArrowBack" },
      fallback: { family: "frick", name: "back" },
    },
    "navigation.threads": {
      web: { family: "lucide", name: "Inbox" },
      ios: { family: "sf", name: "tray.fill" },
      android: { family: "material", name: "MailOutline" },
      fallback: { family: "frick", name: "threads" },
    },
    "status.live": {
      web: { family: "lucide", name: "RadioTower" },
      ios: { family: "sf", name: "antenna.radiowaves.left.and.right" },
      android: { family: "material", name: "WifiTethering" },
      fallback: { family: "frick", name: "status-live" },
    },
    "chat.message": {
      web: { family: "lucide", name: "MessageCircle" },
      ios: { family: "sf", name: "message.fill" },
      android: { family: "material", name: "ChatBubble" },
      fallback: { family: "frick", name: "chat-message" },
    },
    "chat.attachment": {
      web: { family: "lucide", name: "Paperclip" },
      ios: { family: "sf", name: "paperclip" },
      android: { family: "material", name: "MailOutline" },
      fallback: { family: "frick", name: "attachment" },
    },
    "call.video": {
      web: { family: "lucide", name: "Video" },
      ios: { family: "sf", name: "video.fill" },
      android: { family: "material", name: "Videocam" },
      fallback: { family: "frick", name: "call-video" },
    },
    "workspace.settings": {
      web: { family: "lucide", name: "Settings" },
      ios: { family: "sf", name: "gearshape" },
      android: { family: "material", name: "Settings" },
      fallback: { family: "frick", name: "settings" },
    },
    "theme.light": {
      web: { family: "lucide", name: "Sun" },
      ios: { family: "sf", name: "sun.max" },
      android: { family: "material", name: "Settings" },
      fallback: { family: "frick", name: "theme-light" },
    },
    "theme.dark": {
      web: { family: "lucide", name: "Moon" },
      ios: { family: "sf", name: "moon" },
      android: { family: "material", name: "Settings" },
      fallback: { family: "frick", name: "theme-dark" },
    },
  },
});
