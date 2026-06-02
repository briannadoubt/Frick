import type { ComponentType, SVGProps } from "react";
import {
  ArrowLeft,
  Inbox,
  Info,
  LoaderCircle,
  MessageCircle,
  Mic,
  Moon,
  Paperclip,
  Plus,
  Radio,
  RefreshCw,
  Send,
  Settings,
  Sun,
  Video,
} from "lucide-react";
import { useDesignContext, type FrickDesignIconPack } from "./provider.js";

export type FrickIcon = ComponentType<SVGProps<SVGSVGElement>>;
export type FrickIconName =
  | "send"
  | "reload"
  | "add"
  | "details"
  | "back"
  | "threads"
  | "live"
  | "message"
  | "paperclip"
  | "mic"
  | "video"
  | "settings"
  | "themeLight"
  | "themeDark";

export const icons = {
  action: {
    send: Send,
    reload: RefreshCw,
    add: Plus,
    details: Info,
    settings: Settings,
  },
  navigation: {
    back: ArrowLeft,
    threads: Inbox,
  },
  status: {
    live: Radio,
    loading: LoaderCircle,
  },
  chat: {
    message: MessageCircle,
    attachment: Paperclip,
    mic: Mic,
  },
  call: {
    video: Video,
  },
} as const;

/**
 * Native icon pack: platform-idiomatic glyphs (lucide on web). Matches the
 * `iconPack: "native"` resolution in `@fricken/design`.
 */
export const nativeIcons: Record<FrickIconName, FrickIcon> = {
  send: icons.action.send,
  reload: icons.action.reload,
  add: icons.action.add,
  details: icons.action.details,
  back: icons.navigation.back,
  threads: icons.navigation.threads,
  live: icons.status.live,
  message: icons.chat.message,
  paperclip: icons.chat.attachment,
  mic: icons.chat.mic,
  video: icons.call.video,
  settings: icons.action.settings,
  themeLight: Sun,
  themeDark: Moon,
};

/**
 * Back-compat alias. Historically `semanticIcons` was the only pack; it maps to
 * the native pack.
 */
export const semanticIcons = nativeIcons;

function frickGlyph(paths: string): FrickIcon {
  return function FrickFallbackIcon(props: SVGProps<SVGSVGElement>) {
    return (
      <svg
        fill="none"
        height="1em"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        viewBox="0 0 24 24"
        width="1em"
        {...props}
        dangerouslySetInnerHTML={{ __html: paths }}
      />
    );
  };
}

/**
 * Frick fallback icon pack: brand-owned geometric glyphs used when the active
 * `iconPack` is not the native platform pack (mirrors the `fallback` family in
 * the `@fricken/design` icon definitions). These are deliberately simple so the
 * pack is fully self-contained and switchable at runtime.
 */
export const frickIcons: Record<FrickIconName, FrickIcon> = {
  send: frickGlyph('<path d="M4 12 20 4 14 20 11 13 4 12Z" />'),
  reload: frickGlyph('<path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 4v4h-4" />'),
  add: frickGlyph('<path d="M12 5v14" /><path d="M5 12h14" />'),
  details: frickGlyph('<circle cx="12" cy="12" r="9" /><path d="M12 8h.01" /><path d="M11 12h1v4h1" />'),
  back: frickGlyph('<path d="M15 5 8 12l7 7" />'),
  threads: frickGlyph('<rect x="4" y="5" width="16" height="14" rx="2" /><path d="M4 9h16" />'),
  live: frickGlyph('<circle cx="12" cy="12" r="3" /><path d="M5 12a7 7 0 0 1 14 0" />'),
  message: frickGlyph('<path d="M5 5h14v10H9l-4 4Z" />'),
  paperclip: frickGlyph('<path d="M17 8 9 16a3 3 0 0 0 4 4l7-7a5 5 0 0 0-7-7l-6 6" />'),
  mic: frickGlyph('<rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0" /><path d="M12 17v4" />'),
  video: frickGlyph('<rect x="3" y="6" width="12" height="12" rx="2" /><path d="M15 10 21 7v10l-6-3Z" />'),
  settings: frickGlyph('<circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" />'),
  themeLight: frickGlyph('<circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2" />'),
  themeDark: frickGlyph('<path d="M20 14a8 8 0 0 1-10-10 8 8 0 1 0 10 10Z" />'),
};

/** Returns the icon component set for a given icon pack. */
export function iconPackFor(iconPack: FrickDesignIconPack): Record<FrickIconName, FrickIcon> {
  return iconPack === "native" ? nativeIcons : frickIcons;
}

export function FrickIconGlyph({ name, ...props }: SVGProps<SVGSVGElement> & { name: FrickIconName }) {
  const { iconPack } = useDesignContext();
  const Icon = iconPackFor(iconPack)[name];
  return <Icon aria-hidden="true" focusable="false" {...props} />;
}
