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

export const semanticIcons: Record<FrickIconName, FrickIcon> = {
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

export function FrickIconGlyph({ name, ...props }: SVGProps<SVGSVGElement> & { name: FrickIconName }) {
  const Icon = semanticIcons[name];
  return <Icon aria-hidden="true" focusable="false" {...props} />;
}
