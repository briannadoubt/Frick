import {
  Activity,
  Database,
  Inbox,
  MessageCircle,
  Signal,
  Users,
  Video,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  FrickProvider,
  useAppend,
  useFrickHttpEndpoint,
  useInbox,
  useObjects,
  usePresence,
  useSendSignal,
  useSetPresence,
  useSignalChannel,
  useStream,
  useSyncStatus,
} from "@frick/react";
import {
  Avatar,
  Button,
  ChatBubble,
  ErrorMessage,
  FrickDesignProvider,
  Heading,
  IconButton,
  MessageList,
  SegmentedControl,
  StatusChip,
  Surface,
  TextField,
  WorkspaceListItem,
  WorkspaceShell,
} from "@frick/design-web";
import { resolveInitialTheme, type ThemePreference } from "./theme.js";
import {
  appendAttachmentMarker,
  buildDemoAttachment,
  createConversation,
  deriveInboxItems,
  login,
  nextReadReceiptPayload,
  sentMessageEvents,
  signUp,
  syncDemoAttachment,
  type AuthSession,
  type AttachmentMetadata,
  type ChatStreamEvent,
  type Conversation,
  type InboxRow,
  type RoomMember,
  type User,
} from "./chat-foundation.js";

const defaultConversationId = "conversation-general";
const demoHttpEndpoint = "http://127.0.0.1:4099";
const authSessionStorageKey = "frick-auth-session";
const webDeviceStorageKey = "frick-web-device-id";
const webReplicaStorageKey = "frick-web-replica-id";

export function App() {
  const [session, setSession] = useState<AuthSession | undefined>(() => readStoredSession());
  const [theme, setTheme] = useState<ThemePreference>(() =>
    resolveInitialTheme(
      window.localStorage.getItem("frick-theme"),
      window.matchMedia("(prefers-color-scheme: dark)").matches,
    ),
  );
  const clientIdentity = useMemo(
    () => ({
      deviceId: readOrCreateStoredId(webDeviceStorageKey, "web-device"),
      replicaId: readOrCreateStoredId(webReplicaStorageKey, "web-replica"),
    }),
    [],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("frick-theme", theme);
  }, [theme]);

  function acceptSession(nextSession: AuthSession) {
    setSession(nextSession);
    window.localStorage.setItem(authSessionStorageKey, JSON.stringify(nextSession));
  }

  function logout() {
    window.localStorage.removeItem(authSessionStorageKey);
    setSession(undefined);
  }

  return (
    <FrickDesignProvider mode={theme} density="comfortable" brand="frickenChat">
      {session ? (
        <FrickProvider key={session.sessionToken} session={session}>
          <ChatWorkspace
            onLogout={logout}
            session={session}
            setTheme={setTheme}
            theme={theme}
          />
        </FrickProvider>
      ) : (
        <AuthWorkspace
          clientIdentity={clientIdentity}
          onAuthenticated={acceptSession}
          setTheme={setTheme}
          theme={theme}
        />
      )}
    </FrickDesignProvider>
  );
}

function AuthWorkspace({
  clientIdentity,
  onAuthenticated,
  theme,
  setTheme,
}: {
  clientIdentity: { deviceId: string; replicaId: string };
  onAuthenticated(session: AuthSession): void;
  theme: ThemePreference;
  setTheme(theme: ThemePreference | ((current: ThemePreference) => ThemePreference)): void;
}) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [identity, setIdentity] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(undefined);
    try {
      const nextSession =
        mode === "signup"
          ? await signUp({
              httpEndpoint: demoHttpEndpoint,
              displayName,
              handle,
              password,
              deviceId: clientIdentity.deviceId,
              replicaId: clientIdentity.replicaId,
              platform: "web",
            })
          : await login({
              httpEndpoint: demoHttpEndpoint,
              identity,
              password,
              deviceId: clientIdentity.deviceId,
              replicaId: clientIdentity.replicaId,
              platform: "web",
            });
      onAuthenticated(nextSession);
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : "Authentication failed");
    } finally {
      setIsSubmitting(false);
    }
  }

  function switchMode(nextMode: "login" | "signup") {
    setMode(nextMode);
    setError(undefined);
  }

  return (
    <main className="shell auth-shell">
      <Surface className="auth-card">
        <header className="auth-header">
          <div>
            <p className="eyebrow">Frick foundation</p>
            <Heading level={1} size="xl">
              Foundation General
            </Heading>
          </div>
          <IconButton
            className="icon-button"
            icon={theme === "dark" ? "themeLight" : "themeDark"}
            label={theme === "dark" ? "Use light theme" : "Use dark theme"}
            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
          />
        </header>

        <SegmentedControl
          aria-label="Authentication mode"
          className="auth-mode"
          options={[
            { value: "login", label: "Log in" },
            { value: "signup", label: "Sign up" },
          ]}
          value={mode}
          onValueChange={(value) => switchMode(value === "signup" ? "signup" : "login")}
        />

        <form className="auth-form" onSubmit={submitAuth}>
          {mode === "signup" ? (
            <TextField
              autoComplete="name"
              label="Display name"
              placeholder="Ada Lovelace"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          ) : null}
          <TextField
            autoComplete="username"
            label="Handle"
            placeholder="ada"
            value={mode === "signup" ? handle : identity}
            onChange={(event) => (mode === "signup" ? setHandle(event.target.value) : setIdentity(event.target.value))}
          />
          <TextField
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            label="Password"
            placeholder="At least 8 characters"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {error ? (
            <ErrorMessage className="auth-note" title="Authentication failed">
              {error}
            </ErrorMessage>
          ) : null}
          <Button className="primary-action" tone="primary" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Working..." : mode === "signup" ? "Create person" : "Log in"}
          </Button>
        </form>
      </Surface>
    </main>
  );
}

function ChatWorkspace({
  session,
  theme,
  setTheme,
  onLogout,
}: {
  session: AuthSession;
  theme: ThemePreference;
  setTheme(theme: ThemePreference | ((current: ThemePreference) => ThemePreference)): void;
  onLogout(): void;
}) {
  const [selectedConversationId, setSelectedConversationId] = useState(defaultConversationId);
  const [draft, setDraft] = useState("");
  const [draftAttachments, setDraftAttachments] = useState<AttachmentMetadata[]>([]);
  const [attachmentStatus, setAttachmentStatus] = useState<string | undefined>();
  const [attachmentError, setAttachmentError] = useState<string | undefined>();
  const [isUploadingAttachment, setIsUploadingAttachment] = useState(false);
  const [threadTitle, setThreadTitle] = useState("");
  const [threadKind, setThreadKind] = useState<"dm" | "group">("dm");
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<string[]>([]);
  const [threadError, setThreadError] = useState<string | undefined>();
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const [createdConversations, setCreatedConversations] = useState<Conversation[]>([]);
  const [createdMembers, setCreatedMembers] = useState<RoomMember[]>([]);
  const [readSequences, setReadSequences] = useState<Record<string, number>>({});
  const [selectedDestination, setSelectedDestination] = useState("chat");
  const [compactThreadsOpen, setCompactThreadsOpen] = useState(() => window.matchMedia("(max-width: 640px)").matches);
  const [inspectorOpen, setInspectorOpen] = useState(() => window.matchMedia("(min-width: 1041px)").matches);
  const activeUserId = session.userId;
  const activeDeviceId = session.deviceId;
  const users = useObjects<User>("User");
  const conversations = useObjects<Conversation>("Conversation");
  const members = useObjects<RoomMember>("RoomMember");
  const remoteInbox = useInbox<InboxRow>(activeUserId);
  const httpEndpoint = useFrickHttpEndpoint();
  const messages = useStream<ChatStreamEvent>("MessageStream", selectedConversationId);
  const typingKey = `${selectedConversationId}:${activeUserId}:${activeDeviceId}`;
  const typing = usePresence<{ isTyping: boolean }>("TypingState", typingKey);
  const setTyping = useSetPresence("TypingState", typingKey);
  const appendMessage = useAppend("MessageStream", selectedConversationId);
  const callKey = `call:${selectedConversationId}`;
  const signals = useSignalChannel("WebRTCSignal", callKey);
  const sendSignal = useSendSignal("WebRTCSignal", callKey);
  const status = useSyncStatus();
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const lastReceiptRef = useRef<Record<string, number>>({});

  const visibleConversations = useMemo(
    () => mergeById(conversations, createdConversations),
    [conversations, createdConversations],
  );
  const visibleMembers = useMemo(
    () => mergeById(members, createdMembers),
    [members, createdMembers],
  );
  const conversation = visibleConversations.find((item) => item.id === selectedConversationId);
  const sortedEvents = useMemo(
    () => [...messages].sort((left, right) => left.sequence - right.sequence),
    [messages],
  );
  const sortedMessages = useMemo(() => sentMessageEvents(sortedEvents), [sortedEvents]);
  const selectedMessages = useMemo(
    () => sortedMessages.filter((message) => message.streamId === selectedConversationId),
    [selectedConversationId, sortedMessages],
  );
  const inboxRows = useMemo(() => normalizeInboxRows(remoteInbox.data), [remoteInbox.data]);
  const inboxItems = useMemo(
    () =>
      deriveInboxItems({
        conversations: visibleConversations,
        inboxRows,
        localMessages: selectedMessages,
        selectedConversationId,
        readSequences,
      }),
    [visibleConversations, inboxRows, readSequences, selectedConversationId, selectedMessages],
  );
  const selectedMembers = useMemo(
    () => visibleMembers.filter((member) => member.conversationId === selectedConversationId),
    [visibleMembers, selectedConversationId],
  );
  const participantOptions = useMemo(
    () => users.filter((user) => user.id !== activeUserId).sort((left, right) => left.displayName.localeCompare(right.displayName)),
    [activeUserId, users],
  );
  const conversationTitle = conversationDisplayTitle({
    activeUserId,
    conversation,
    conversationId: selectedConversationId,
    members: selectedMembers,
    users,
  });
  const canCreateThread =
    !isCreatingThread &&
    (threadKind === "dm"
      ? selectedParticipantIds.length === 1
      : threadTitle.trim().length > 0 && selectedParticipantIds.length > 0);
  const latestMessageSequence = selectedMessages.at(-1)?.sequence ?? 0;
  const lastCursor = Math.max(0, ...Object.values(status.cursors));
  const workspaceDestinations = useMemo(
    () => [
      { id: "chat", label: "Chat", icon: "message" as const },
      { id: "files", label: "Files", icon: "paperclip" as const, disabled: true, badge: "Soon" },
      { id: "calls", label: "Calls", icon: "video" as const, disabled: true, badge: "Soon" },
      { id: "admin", label: "Admin", icon: "settings" as const, disabled: true, badge: "Soon" },
    ],
    [],
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [selectedMessages.length, selectedMessages.at(-1)?.eventId]);

  useEffect(() => {
    advanceReadCursor();
  }, [latestMessageSequence, selectedConversationId]);

  async function submitMessage(nextDraft = draft) {
    const body = appendAttachmentMarker(nextDraft, draftAttachments);
    if (!body) {
      return;
    }
    setDraft("");
    setDraftAttachments([]);
    setAttachmentStatus(undefined);
    setAttachmentError(undefined);
    await setTyping({ isTyping: false });
    const attachmentBlobIds = draftAttachments.map((attachment) => attachment.blobId);
    await appendMessage("MessageSent", {
      messageId: `message-${crypto.randomUUID()}`,
      senderId: activeUserId,
      body,
      createdAt: new Date().toISOString(),
      ...(attachmentBlobIds.length > 0 ? { attachmentBlobIds } : {}),
    });
  }

  async function updateDraft(value: string) {
    setDraft(value);
    await setTyping({ isTyping: value.trim().length > 0 });
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    void submitMessage(event.currentTarget.value);
  }

  async function createThread(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = threadTitle.trim();
    if (!canCreateThread) {
      setThreadError(threadKind === "dm" ? "Choose one person" : "Choose people and a title");
      return;
    }

    setIsCreatingThread(true);
    setThreadError(undefined);
    try {
      const created = await createConversation({
        httpEndpoint,
        ...(threadKind === "group" ? { title } : {}),
        kind: threadKind,
        participantUserIds: selectedParticipantIds,
        sessionToken: session.sessionToken,
      });
      setCreatedConversations((current) => mergeById(current, [created.conversation]));
      setCreatedMembers((current) => mergeById(current, created.members ?? [created.member]));
      setSelectedConversationId(created.conversation.id);
      setCompactThreadsOpen(false);
      setThreadTitle("");
      setSelectedParticipantIds([]);
      setDraft("");
      setDraftAttachments([]);
      setAttachmentStatus(undefined);
      setAttachmentError(undefined);
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : "Could not create thread");
    } finally {
      setIsCreatingThread(false);
    }
  }

  function changeThreadKind(value: string) {
    const nextKind = value === "group" ? "group" : "dm";
    setThreadKind(nextKind);
    setThreadError(undefined);
    setSelectedParticipantIds((current) => (nextKind === "dm" ? current.slice(0, 1) : current));
  }

  function toggleThreadParticipant(userId: string) {
    setThreadError(undefined);
    setSelectedParticipantIds((current) => {
      if (threadKind === "dm") {
        return current[0] === userId ? [] : [userId];
      }
      return current.includes(userId) ? current.filter((candidate) => candidate !== userId) : [...current, userId];
    });
  }

  async function addDemoAttachment() {
    setIsUploadingAttachment(true);
    setAttachmentStatus("Uploading demo attachment...");
    setAttachmentError(undefined);
    try {
      const attachment = await buildDemoAttachment();
      await syncDemoAttachment({
        httpEndpoint,
        attachment,
        ownerId: activeUserId,
        sessionToken: session.sessionToken,
      });
      setDraftAttachments((current) => [
        ...current,
        {
          blobId: attachment.blobId,
          name: attachment.name,
          byteLength: attachment.byteLength,
          mimeType: attachment.mimeType,
          contentHash: attachment.contentHash,
        },
      ]);
      setAttachmentStatus(`Uploaded ${attachment.name} (${formatByteCount(attachment.byteLength)})`);
    } catch (error) {
      setAttachmentStatus(undefined);
      setAttachmentError(error instanceof Error ? error.message : "Attachment upload failed");
    } finally {
      setIsUploadingAttachment(false);
    }
  }

  function removeDraftAttachment(blobId: string) {
    setDraftAttachments((current) => current.filter((attachment) => attachment.blobId !== blobId));
    setAttachmentStatus(undefined);
  }

  function selectConversation(nextConversationId: string) {
    setSelectedConversationId(nextConversationId);
    setCompactThreadsOpen(false);
    setDraft("");
    setDraftAttachments([]);
    setAttachmentStatus(undefined);
    setAttachmentError(undefined);
  }

  function advanceReadCursor() {
    const payload = nextReadReceiptPayload({
      userId: activeUserId,
      messages: selectedMessages,
      lastSentSequence: lastReceiptRef.current[selectedConversationId] ?? readSequences[selectedConversationId] ?? 0,
    });
    if (!payload) {
      return;
    }
    lastReceiptRef.current[selectedConversationId] = payload.sequence;
    setReadSequences((current) => ({
      ...current,
      [selectedConversationId]: Math.max(current[selectedConversationId] ?? 0, payload.sequence),
    }));
    void appendMessage("ReceiptAdvanced", payload);
  }

  async function sendFakeSignal() {
    await sendSignal({
      senderDeviceId: activeDeviceId,
      kind: "offer",
      payload: new Uint8Array([signals.length + 1]),
    });
  }

  function renderChatHeader() {
    return (
      <header className="topbar">
        <Button className="compact-nav-action" icon="threads" onClick={() => setCompactThreadsOpen(true)}>
          Threads
        </Button>
        <div>
          <p className="eyebrow">Frick foundation</p>
          <h1>{conversationTitle}</h1>
        </div>
      </header>
    );
  }

  function renderWorkspaceActions() {
    return (
      <div className="top-actions">
        <div className="account-chip" aria-label="Signed in user">
          <Avatar name={session.displayName ?? displayName(users, activeUserId)} size="sm" />
          <span>
            <strong>{session.displayName ?? displayName(users, activeUserId)}</strong>
            <small>{session.handle ? `@${session.handle}` : activeUserId}</small>
          </span>
        </div>
        <StatusChip className="status" data-connected={status.connected} icon="live" tone={status.connected ? "success" : "muted"}>
          {status.connected ? "Live" : "Offline"}
        </StatusChip>
        <IconButton
          className="icon-button"
          icon="details"
          label={inspectorOpen ? "Hide details" : "Show details"}
          onClick={() => setInspectorOpen((current) => !current)}
        />
        <Button className="text-action" onClick={onLogout}>
          Log out
        </Button>
        <IconButton
          className="icon-button"
          icon={theme === "dark" ? "themeLight" : "themeDark"}
          label={theme === "dark" ? "Use light theme" : "Use dark theme"}
          onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
        />
      </div>
    );
  }

  function renderThreadsPanel() {
    return (
      <Surface className="panel side-panel">
        <PanelTitle icon={<Inbox size={18} />} title="Threads" />
        <form className="thread-create" onSubmit={(event) => void createThread(event)}>
          <SegmentedControl
            aria-label="Thread type"
            className="thread-kind-control"
            options={[
              { value: "dm", label: "Direct" },
              { value: "group", label: "Group" },
            ]}
            value={threadKind}
            onValueChange={changeThreadKind}
          />
          {threadKind === "group" ? (
            <TextField
              aria-label="New thread title"
              className="thread-title-field"
              placeholder="Group title"
              value={threadTitle}
              onChange={(event) => {
                setThreadTitle(event.target.value);
                setThreadError(undefined);
              }}
            />
          ) : null}
          <div className="participant-picker" aria-label="People">
            {participantOptions.map((user) => {
              const selected = selectedParticipantIds.includes(user.id);
              return (
                <Button
                  aria-pressed={selected}
                  className="participant-chip"
                  data-selected={selected}
                  key={user.id}
                  onClick={() => toggleThreadParticipant(user.id)}
                  size="sm"
                >
                  <Avatar name={user.displayName} size="sm" />
                  {user.displayName}
                </Button>
              );
            })}
          </div>
          <Button className="thread-submit-action" type="submit" tone="primary" icon="add" disabled={!canCreateThread}>
            {threadKind === "dm" ? "Start direct" : "Create group"}
          </Button>
        </form>
        {threadError ? (
          <p className="thread-error" role="alert">
            {threadError}
          </p>
        ) : null}
        <div className="inbox-list" aria-label="Conversations">
          {inboxItems.map((item) => (
            <WorkspaceListItem
              className="inbox-row"
              key={item.conversationId}
              selected={item.selected}
              title={conversationDisplayTitle({
                activeUserId,
                conversation: visibleConversations.find((candidate) => candidate.id === item.conversationId),
                conversationId: item.conversationId,
                members: visibleMembers.filter((member) => member.conversationId === item.conversationId),
                users,
              })}
              subtitle={item.preview}
              meta={`Read #${item.readSequence} / Last #${item.lastSequence}`}
              badge={item.unreadCount > 0 ? item.unreadCount : undefined}
              onClick={() => selectConversation(item.conversationId)}
            />
          ))}
        </div>
      </Surface>
    );
  }

  function renderChatMessages() {
    return (
      <section className="panel message-panel">
        <div className="panel-head">
          <PanelTitle icon={<MessageCircle size={18} />} title="Messages" />
          <div className="typing" data-active={typing?.isTyping === true}>
            {typing?.isTyping ? "Typing" : "Idle"}
          </div>
        </div>

        <MessageList className="messages" onScroll={advanceReadCursor}>
          {selectedMessages.map((message) => (
            <ChatBubble
              author={displayName(users, message.payload.senderId)}
              key={message.eventId}
              timestamp={new Date(message.payload.createdAt).toLocaleTimeString()}
              variant={message.payload.senderId === activeUserId ? "outgoing" : "incoming"}
            >
              {message.payload.body}
            </ChatBubble>
          ))}
          {selectedMessages.length === 0 ? <p className="empty">No messages yet</p> : null}
          <div aria-hidden="true" ref={messagesEndRef} />
        </MessageList>
      </section>
    );
  }

  function renderChatComposer() {
    return (
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submitMessage();
        }}
      >
        {draftAttachments.length > 0 ? (
          <div className="attachment-tray">
            {draftAttachments.map((attachment) => (
              <Button
                className="attachment-chip"
                icon="paperclip"
                key={attachment.blobId}
                onClick={() => removeDraftAttachment(attachment.blobId)}
              >
                {attachment.name}
              </Button>
            ))}
          </div>
        ) : null}
        {attachmentStatus ? (
          <p className="composer-status" role="status">
            {attachmentStatus}
          </p>
        ) : null}
        {attachmentError ? (
          <p className="composer-error" role="alert">
            {attachmentError}
          </p>
        ) : null}
        <TextField
          aria-label="Message"
          className="composer-field"
          placeholder="Message the foundation"
          value={draft}
          onChange={(event) => void updateDraft(event.target.value)}
          onKeyDown={handleComposerKeyDown}
        />
        <IconButton
          className="attach-button"
          icon="paperclip"
          label={isUploadingAttachment ? "Uploading demo attachment" : "Add demo attachment"}
          disabled={isUploadingAttachment}
          onClick={() => void addDemoAttachment()}
        />
        <IconButton type="submit" icon="send" label="Send message" tone="primary" />
      </form>
    );
  }

  function renderChatInspector() {
    return (
      <div className="inspector-stack">
        <section className="metrics compact-metrics" aria-label="Runtime metrics">
          <Metric icon={<Database size={20} />} label="Schema" value="foundation" />
          <Metric icon={<Activity size={20} />} label="Cursor" value={`#${lastCursor}`} />
          <Metric icon={<Signal size={20} />} label="Pending" value={String(status.pendingMutations)} />
        </section>

        <section className="panel call-panel">
          <PanelTitle icon={<Video size={18} />} title="Signals" />
          <strong className="signal-count">{signals.length}</strong>
          <Button className="secondary-action" onClick={() => void sendFakeSignal()}>
            Send offer
          </Button>
        </section>

        <section className="panel member-section">
          <PanelTitle icon={<Users size={18} />} title="Members" />
          <div className="user-list">
            {selectedMembers.length > 0 ? (
              selectedMembers.map((member) => (
                <div className="user-row" key={member.id}>
                  <Avatar name={displayName(users, member.userId)} size="sm" />
                  <strong>{displayName(users, member.userId)}</strong>
                </div>
              ))
            ) : (
              <p className="empty">No members yet</p>
            )}
          </div>
        </section>
      </div>
    );
  }

  return (
    <WorkspaceShell
      className="chat-workspace-shell"
      destinations={workspaceDestinations}
      navigationLabel={<span className="workspace-brand">Frick</span>}
      navigationActions={renderWorkspaceActions()}
      compactCollectionVisible={compactThreadsOpen}
      selectedDestination={selectedDestination}
      onDestinationChange={(destinationId) => {
        setSelectedDestination(destinationId);
        setCompactThreadsOpen(false);
      }}
      collection={renderThreadsPanel()}
      header={renderChatHeader()}
      footer={selectedDestination === "chat" ? renderChatComposer() : undefined}
      inspector={renderChatInspector()}
      inspectorOpen={inspectorOpen}
      onInspectorOpenChange={setInspectorOpen}
    >
      {selectedDestination === "chat" ? (
        renderChatMessages()
      ) : (
        <PlaceholderDestination
          destination={workspaceDestinations.find((item) => item.id === selectedDestination)?.label ?? "Destination"}
        />
      )}
    </WorkspaceShell>
  );
}

function PlaceholderDestination({ destination }: { destination: ReactNode }) {
  return (
    <section className="placeholder-destination">
      <p className="eyebrow">Coming soon</p>
      <h2>{destination}</h2>
      <p>This destination is not enabled in the web demo yet.</p>
    </section>
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

function conversationDisplayTitle({
  activeUserId,
  conversation,
  conversationId,
  members,
  users,
}: {
  activeUserId: string;
  conversation: Conversation | undefined;
  conversationId: string;
  members: RoomMember[];
  users: User[];
}): string {
  if (conversation?.title?.trim()) {
    return conversation.title.trim();
  }
  if (conversation?.kind === "dm") {
    const peer = members.find((member) => member.userId !== activeUserId) ?? members[0];
    return peer ? displayName(users, peer.userId) : "Direct message";
  }
  if (members.length > 0) {
    return members
      .filter((member) => member.userId !== activeUserId)
      .map((member) => displayName(users, member.userId))
      .slice(0, 3)
      .join(", ") || "Personal thread";
  }
  return titleFromConversationId(conversationId);
}

function titleFromConversationId(conversationId: string): string {
  return conversationId
    .replace(/^conversation-/, "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeInboxRows(data: ReturnType<typeof useInbox<InboxRow>>["data"]): InboxRow[] | undefined {
  if (Array.isArray(data)) {
    return data;
  }
  if (data && Array.isArray(data.data)) {
    return data.data;
  }
  return undefined;
}

function mergeById<T extends { id: string }>(base: T[], overlay: T[]): T[] {
  const values = new Map(base.map((item) => [item.id, item]));
  for (const item of overlay) {
    values.set(item.id, item);
  }
  return Array.from(values.values()).sort((left, right) => left.id.localeCompare(right.id));
}

function formatByteCount(byteLength: number): string {
  return byteLength < 1024 ? `${byteLength} B` : `${Math.round(byteLength / 1024)} KB`;
}

function readStoredSession(): AuthSession | undefined {
  const stored = window.localStorage.getItem(authSessionStorageKey);
  if (!stored) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(stored) as Partial<AuthSession>;
    if (
      typeof parsed.sessionToken === "string" &&
      typeof parsed.userId === "string" &&
      typeof parsed.deviceId === "string" &&
      typeof parsed.replicaId === "string" &&
      typeof parsed.schemaHash === "string" &&
      typeof parsed.expiresAt === "string"
    ) {
      return parsed as AuthSession;
    }
  } catch {
    window.localStorage.removeItem(authSessionStorageKey);
  }
  return undefined;
}

function readOrCreateStoredId(storageKey: string, prefix: string): string {
  const existing = window.localStorage.getItem(storageKey);
  if (existing) {
    return existing;
  }
  const next = `${prefix}-${crypto.randomUUID()}`;
  window.localStorage.setItem(storageKey, next);
  return next;
}
