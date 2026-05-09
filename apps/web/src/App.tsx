import {
  Activity,
  Database,
  MessageCircle,
  Moon,
  RadioTower,
  Send,
  Signal,
  Sun,
  Users,
  Video,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  useAppend,
  useObjects,
  usePresence,
  useSendSignal,
  useSetPresence,
  useSignalChannel,
  useStream,
  useSyncStatus,
} from "@frick/react";
import type { PlainObject, StreamEventInput } from "@frick/protocol";
import { resolveInitialTheme, type ThemePreference } from "./theme.js";

const conversationId = "conversation-general";
const localUserId = "user-ada";
const localDeviceId = "web-device";
const typingKey = `${conversationId}:${localUserId}:${localDeviceId}`;
const callKey = "call-demo";

type User = PlainObject & {
  id: string;
  displayName: string;
};

type Conversation = PlainObject & {
  id: string;
  title?: string;
  kind: string;
};

type MessageEvent = StreamEventInput & {
  payload: {
    messageId: string;
    senderId: string;
    body: string;
    createdAt: string;
  };
};

export function App() {
  const [theme, setTheme] = useState<ThemePreference>(() =>
    resolveInitialTheme(
      window.localStorage.getItem("frick-theme"),
      window.matchMedia("(prefers-color-scheme: dark)").matches,
    ),
  );
  const [draft, setDraft] = useState("");
  const users = useObjects<User>("User");
  const conversations = useObjects<Conversation>("Conversation");
  const messages = useStream<MessageEvent>("MessageStream", conversationId);
  const typing = usePresence<{ isTyping: boolean }>("TypingState", typingKey);
  const setTyping = useSetPresence("TypingState", typingKey);
  const appendMessage = useAppend("MessageStream", conversationId);
  const signals = useSignalChannel("WebRTCSignal", callKey);
  const sendSignal = useSendSignal("WebRTCSignal", callKey);
  const status = useSyncStatus();
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const conversation = conversations.find((item) => item.id === conversationId);
  const sortedMessages = useMemo(
    () => [...messages].sort((left, right) => left.sequence - right.sequence),
    [messages],
  );
  const lastCursor = Math.max(0, ...Object.values(status.cursors));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("frick-theme", theme);
  }, [theme]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [sortedMessages.length, sortedMessages.at(-1)?.eventId]);

  async function submitMessage() {
    const body = draft.trim();
    if (!body) {
      return;
    }
    setDraft("");
    await appendMessage("MessageSent", {
      messageId: `message-${crypto.randomUUID()}`,
      senderId: localUserId,
      body,
      createdAt: new Date().toISOString(),
    });
  }

  async function updateDraft(value: string) {
    setDraft(value);
    await setTyping({ isTyping: value.trim().length > 0 });
  }

  async function sendFakeSignal() {
    await sendSignal({
      senderDeviceId: localDeviceId,
      kind: "offer",
      payload: new Uint8Array([signals.length + 1]),
    });
  }

  return (
    <main className="shell">
      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Frick foundation</p>
            <h1>{conversation?.title ?? "Foundation General"}</h1>
          </div>
          <div className="top-actions">
            <div className="status" data-connected={status.connected}>
              <RadioTower size={18} />
              <span>{status.connected ? "Live" : "Offline"}</span>
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label={theme === "dark" ? "Use light theme" : "Use dark theme"}
              title={theme === "dark" ? "Use light theme" : "Use dark theme"}
              onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            >
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
        </header>

        <section className="metrics" aria-label="Runtime metrics">
          <Metric icon={<Database size={20} />} label="Schema" value="foundation" />
          <Metric icon={<Activity size={20} />} label="Cursor" value={`#${lastCursor}`} />
          <Metric icon={<Signal size={20} />} label="Pending" value={String(status.pendingMutations)} />
        </section>

        <section className="grid">
          <aside className="panel side-panel">
            <PanelTitle icon={<Users size={18} />} title="Users" />
            <div className="user-list">
              {users.map((user) => (
                <div className="user-row" key={user.id}>
                  <span>{initials(user.displayName)}</span>
                  <strong>{user.displayName}</strong>
                </div>
              ))}
            </div>
          </aside>

          <section className="panel message-panel">
            <div className="panel-head">
              <PanelTitle icon={<MessageCircle size={18} />} title="Messages" />
              <div className="typing" data-active={typing?.isTyping === true}>
                {typing?.isTyping ? "Typing" : "Idle"}
              </div>
            </div>

            <div className="messages">
              {sortedMessages.map((message) => (
                <article className="message" key={message.eventId}>
                  <div className="message-meta">
                    <strong>{displayName(users, message.payload.senderId)}</strong>
                    <span>{new Date(message.payload.createdAt).toLocaleTimeString()}</span>
                  </div>
                  <p>{message.payload.body}</p>
                </article>
              ))}
              {sortedMessages.length === 0 ? <p className="empty">No messages yet</p> : null}
              <div aria-hidden="true" ref={messagesEndRef} />
            </div>

            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                void submitMessage();
              }}
            >
              <input
                aria-label="Message"
                placeholder="Message the foundation"
                value={draft}
                onChange={(event) => void updateDraft(event.target.value)}
              />
              <button type="submit" aria-label="Send message">
                <Send size={18} />
              </button>
            </form>
          </section>

          <aside className="panel call-panel">
            <PanelTitle icon={<Video size={18} />} title="Signals" />
            <strong className="signal-count">{signals.length}</strong>
            <button className="secondary-action" type="button" onClick={() => void sendFakeSignal()}>
              Send offer
            </button>
          </aside>
        </section>
      </section>
    </main>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="metric">
      <div className="metric-icon">{icon}</div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function PanelTitle({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="panel-title">
      {icon}
      <h2>{title}</h2>
    </div>
  );
}

function displayName(users: User[], userId: string): string {
  return users.find((user) => user.id === userId)?.displayName ?? userId;
}

function initials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
