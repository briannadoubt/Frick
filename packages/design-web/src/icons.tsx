import type { ComponentType, SVGProps } from "react";
import { LoaderCircle, MessageCircle, Paperclip, Radio, RefreshCw, Send, Settings, Video } from "lucide-react";

export type FrickIcon = ComponentType<SVGProps<SVGSVGElement>>;
export type FrickIconName = "send" | "reload" | "live" | "message" | "paperclip" | "video" | "settings";

export const icons = {
  action: {
    send: Send,
    reload: RefreshCw,
    settings: Settings,
  },
  status: {
    live: Radio,
    loading: LoaderCircle,
  },
  chat: {
    message: MessageCircle,
    attachment: Paperclip,
  },
  call: {
    video: Video,
  },
} as const;

export const semanticIcons: Record<FrickIconName, FrickIcon> = {
  send: icons.action.send,
  reload: icons.action.reload,
  live: icons.status.live,
  message: icons.chat.message,
  paperclip: icons.chat.attachment,
  video: icons.call.video,
  settings: icons.action.settings,
};

export function FrickIconGlyph({ name, ...props }: SVGProps<SVGSVGElement> & { name: FrickIconName }) {
  const Icon = semanticIcons[name];
  return <Icon aria-hidden="true" focusable="false" {...props} />;
}
