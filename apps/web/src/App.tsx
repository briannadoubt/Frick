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
  FileDropzone,
  FrickProvider,
  RequireAuth,
  useAppend,
  useDraft,
  useMessageActions,
  useReadReceipts,
  useSignIn,
  useSignUp,
  useTyping,
  useVoiceMemo,
  useFrickHttpEndpoint,
  useInbox,
  useObjects,
  usePasteImageUpload,
  usePresence,
  useProjection,
  useReactions,
  useSearch,
  useSendSignal,
  useSetPresence,
  useSignalChannel,
  useStream,
  useSyncStatus,
  useUpsertObject,
} from "@frick/react";
import { FrickDevtools } from "@frick/devtools";
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
// Helpers moved into @frick/core/chat (Phase 1c). The local
// `chat-foundation.ts` shim was deleted in Phase 3b; imports now point
// at the canonical home.
import {
  appendAttachmentMarker,
  blobDerivativeUrl,
  buildDemoAttachment,
  createConversation,
  deriveInboxItems,
  login,
  nextReadReceiptPayload,
  projectionInboxRowsForUser,
  readReceiptsForConversation,
  registerPushDevice,
  revokePushDevice,
  searchMessages,
  sentMessageEvents,
  signUp,
  syncDemoAttachment,
  uploadImageAttachment,
  type AuthSession,
  type AttachmentMetadata,
  type ChatMessageEvent,
  type ChatStreamEvent,
  type Conversation,
  type InboxRow,
  type PushRegistration,
  type RoomMember,
  type SearchHit,
  type User,
} from "@frick/core/chat";

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
      {/* Phase 3 — `<FrickProvider>` hoisted above the auth gate so
          `<RequireAuth>` and the `useSignIn` / `useSignUp` hooks can
          run from inside the auth screen. The provider tolerates a
          null session; the WebSocket reconnects with the new bearer
          token automatically when the session prop changes. */}
      <FrickProvider endpoint="ws://127.0.0.1:4099/_frick/sync" session={session ?? null}>
        <RequireAuth
          fallback={
            <AuthWorkspace
              clientIdentity={clientIdentity}
              onAuthenticated={acceptSession}
              setTheme={setTheme}
              theme={theme}
            />
          }
        >
          {session ? (
            <ChatWorkspace
              onLogout={logout}
              session={session}
              setTheme={setTheme}
              theme={theme}
            />
          ) : null}
        </RequireAuth>
      </FrickProvider>
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
  // Phase 3 — `useSignIn` / `useSignUp` own the HTTP request + bearer-token
  // wiring. The hooks call `client.setSession(...)` on success so the
  // surrounding `<FrickProvider>` reconnects with the new token; we still
  // notify `onAuthenticated` so the App-level session state + localStorage
  // mirror the live session.
  const { signIn, isPending: isSigningIn } = useSignIn();
  const { signUp: doSignUp, isPending: isSigningUp } = useSignUp();
  const isSubmitting = isSigningIn || isSigningUp;

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    try {
      const nextSession =
        mode === "signup"
          ? await doSignUp({
              displayName,
              handle,
              password,
              deviceId: clientIdentity.deviceId,
              replicaId: clientIdentity.replicaId,
              platform: "web",
            })
          : await signIn({
              identity,
              password,
              deviceId: clientIdentity.deviceId,
              replicaId: clientIdentity.replicaId,
              platform: "web",
            });
      onAuthenticated(nextSession);
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : "Authentication failed");
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
  // Phase 6 — composer drafts persisted per (user, conversation) so a reload
  // doesn't lose typing. The hook's setter handles "" by removing the
  // storage entry, so existing `setDraft("")` call-sites continue to work.
  const { draft, setDraft } = useDraft(selectedConversationId);
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
  // Phase 3 — debounced FTS search hook replaces the hand-rolled
  // fetch/debounce/error state below. Re-runs on every keystroke; the
  // hook cancels stale requests on its own.
  const [searchQuery, setSearchQuery] = useState("");
  const {
    response: searchResponse,
    isLoading: isSearching,
    error: searchHookError,
  } = useSearch(searchQuery, {
    conversationId: selectedConversationId,
    debounceMs: 200,
  });
  const searchResults = searchResponse?.hits ?? [];
  const searchError = searchHookError?.message;
  const [pushRegistration, setPushRegistration] = useState<PushRegistration | undefined>(
    () => readStoredPushRegistration(),
  );
  const [pushError, setPushError] = useState<string | undefined>();
  const [isTogglingPush, setIsTogglingPush] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const [displayNameError, setDisplayNameError] = useState<string | undefined>();
  const [displayNameStatus, setDisplayNameStatus] = useState<string | undefined>();
  const [isSavingDisplayName, setIsSavingDisplayName] = useState(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const activeUserId = session.userId;
  const activeDeviceId = session.deviceId;

  // Phase 4 — paste-to-attach. Cmd-V / Ctrl-V of any image lands in the
  // composer attachment tray. Re-uses the same upload pipeline as drag-
  // and-drop and the explicit "attach" button.
  usePasteImageUpload({
    onUpload: (metadata) => {
      setDraftAttachments((current) => [...current, metadata]);
      setAttachmentStatus(`Attached ${metadata.name} (${formatByteCount(metadata.byteLength)})`);
    },
    onError: (error) => setAttachmentError(error.message),
    compression: { maxDimension: 2048, quality: 0.85 },
  });
  const users = useObjects<User>("User");
  const conversations = useObjects<Conversation>("Conversation");
  const members = useObjects<RoomMember>("RoomMember");
  // Live inbox: subscribe to the conversation-inbox projection, filtered
  // client-side to the active user. useInbox stays around as a cold-start
  // fallback so the first paint isn't empty before the WS connects.
  const projectionInbox = useProjection<InboxRow>("conversation-inbox");
  const remoteInbox = useInbox<InboxRow>(activeUserId);
  const httpEndpoint = useFrickHttpEndpoint();
  const upsertUser = useUpsertObject<User>("User");
  // Phase 3 shape: `useStream` returns `{ events, loadOlder, hasMore, loading }`.
  // The demo currently only consumes the live tail; `loadOlder` will hook
  // into a scrollback button in a future iteration.
  const { events: messages } = useStream<ChatStreamEvent>("MessageStream", selectedConversationId);
  // Phase 4 — typing indicator hook with built-in 2.5s auto-stop tail.
  // Reads `TypingState` presence; the active user's row is what we
  // surface today (cross-user presence-list is a framework follow-up).
  const { typingUserIds, setTyping } = useTyping(selectedConversationId);
  // Mirror the legacy `{ isTyping: boolean }` shape the demo's later
  // code consumes from `typing?.isTyping`. The hook tells us *who* is
  // typing; we just need to know whether the row is non-empty here.
  const typing = typingUserIds.length > 0 ? { isTyping: true } : undefined;
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
  // Phase 4 — apply MessageEdited / MessageRedacted events on top of
  // the MessageSent list so edits update inline and redactions render
  // as tombstones. Streams stay append-only on the wire; this is a
  // pure client-side projection.
  const selectedMessages = useMemo(
    () =>
      applyMessageEdits(
        sortedMessages.filter((message) => message.streamId === selectedConversationId),
        sortedEvents.filter((event) => event.streamId === selectedConversationId),
      ),
    [selectedConversationId, sortedMessages, sortedEvents],
  );
  const liveInboxRows = useMemo(
    () => projectionInboxRowsForUser(projectionInbox, activeUserId),
    [projectionInbox, activeUserId],
  );
  const fallbackInboxRows = useMemo(() => normalizeInboxRows(remoteInbox.data), [remoteInbox.data]);
  // Prefer the live projection deltas; only fall back to the HTTP snapshot
  // before the WS subscription has produced any rows.
  const inboxRows: InboxRow[] =
    liveInboxRows.length > 0 ? liveInboxRows : fallbackInboxRows ?? [];
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
  // Phase 4 — read receipts via the bundled hook. Reads the
  // conversation-inbox projection and filters to the current
  // conversation's members; same output shape as the hand-rolled
  // computation below used to produce.
  const readReceipts = useReadReceipts({
    conversationId: selectedConversationId,
    members: visibleMembers,
  });
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
    setTyping(false);
    const attachmentBlobIds = draftAttachments.map((attachment) => attachment.blobId);
    await appendMessage("MessageSent", {
      messageId: `message-${crypto.randomUUID()}`,
      senderId: activeUserId,
      body,
      createdAt: new Date().toISOString(),
      ...(attachmentBlobIds.length > 0 ? { attachmentBlobIds } : {}),
    });
  }

  function updateDraft(value: string) {
    setDraft(value);
    setTyping(value.trim().length > 0);
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

  async function attachImage(file: File) {
    setIsUploadingAttachment(true);
    setAttachmentStatus(`Uploading ${file.name}...`);
    setAttachmentError(undefined);
    try {
      const attachment = await uploadImageAttachment({
        httpEndpoint,
        file,
        ownerId: activeUserId,
        sessionToken: session.sessionToken,
      });
      setDraftAttachments((current) => [...current, attachment]);
      setAttachmentStatus(`Attached ${attachment.name} (${formatByteCount(attachment.byteLength)})`);
    } catch (error) {
      setAttachmentStatus(undefined);
      setAttachmentError(error instanceof Error ? error.message : "Image upload failed");
    } finally {
      setIsUploadingAttachment(false);
      if (imageInputRef.current) {
        imageInputRef.current.value = "";
      }
    }
  }

  // Search is fully driven by the `useSearch` hook above — the explicit
  // submit handler stays around so users hitting Enter feels natural,
  // but it's a no-op because the hook already runs on every keystroke.
  function runSearch(_query: string): void {
    /* no-op; useSearch handles it */
  }

  function jumpToSearchHit(hit: SearchHit) {
    const conversationId =
      typeof hit.fields.conversationId === "string" ? hit.fields.conversationId : undefined;
    if (conversationId) {
      selectConversation(conversationId);
    }
    // The MessageList is keyed by eventId; scroll once the conversation hydrates.
    window.setTimeout(() => {
      const target = document.querySelector(`[data-event-id="${cssEscape(hit.docId)}"]`);
      if (target && "scrollIntoView" in target) {
        (target as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 120);
  }

  async function togglePushRegistration() {
    setIsTogglingPush(true);
    setPushError(undefined);
    try {
      if (pushRegistration) {
        await revokePushDevice({
          httpEndpoint,
          registrationId: pushRegistration.id,
          sessionToken: session.sessionToken,
        });
        setPushRegistration(undefined);
        clearStoredPushRegistration();
      } else {
        const registration = await registerPushDevice({
          httpEndpoint,
          deviceId: activeDeviceId,
          token: `web-test-${crypto.randomUUID()}`,
          platform: "test",
          environment: "production",
          sessionToken: session.sessionToken,
        });
        setPushRegistration(registration);
        writeStoredPushRegistration(registration);
      }
    } catch (error) {
      setPushError(error instanceof Error ? error.message : "Push toggle failed");
    } finally {
      setIsTogglingPush(false);
    }
  }

  async function saveDisplayName() {
    const trimmed = displayNameDraft.trim();
    if (!trimmed) {
      setDisplayNameError("Display name cannot be empty");
      return;
    }
    setIsSavingDisplayName(true);
    setDisplayNameError(undefined);
    setDisplayNameStatus(undefined);
    try {
      const existing = users.find((user) => user.id === activeUserId);
      await upsertUser(activeUserId, { ...(existing ?? {}), id: activeUserId, displayName: trimmed });
      setDisplayNameStatus(`Saved as "${trimmed}"`);
    } catch (error) {
      setDisplayNameError(
        error instanceof Error ? error.message : "Could not update display name",
      );
    } finally {
      setIsSavingDisplayName(false);
    }
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
        <span
          aria-label={syncStatusLabel(status)}
          className="sync-status-dot"
          data-tone={syncStatusTone(status)}
          role="img"
          title={syncStatusTooltip(status)}
        />
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
          {selectedMessages.map((message, index) => {
            const isLatest = index === selectedMessages.length - 1;
            const readBy = isLatest
              ? readReceipts.filter((r) => r.readSequence >= message.sequence)
              : [];
            const attachmentBlobIds = readAttachmentBlobIds(message);
            return (
              <div className="message-row" data-event-id={message.eventId} key={message.eventId}>
                <ChatBubble
                  author={displayName(users, message.payload.senderId)}
                  timestamp={new Date(message.payload.createdAt).toLocaleTimeString()}
                  variant={message.payload.senderId === activeUserId ? "outgoing" : "incoming"}
                >
                  {message.payload.body}
                </ChatBubble>
                {attachmentBlobIds.length > 0 ? (
                  <div className="message-attachments" aria-label="Attachments">
                    {attachmentBlobIds.map((blobId) => (
                      <AttachmentThumbnail
                        blobId={blobId}
                        httpEndpoint={httpEndpoint}
                        key={blobId}
                        sessionToken={session.sessionToken}
                      />
                    ))}
                  </div>
                ) : null}
                <MessageReactions
                  conversationId={selectedConversationId}
                  messageId={message.payload.messageId}
                />
                {message.payload.senderId === activeUserId ? (
                  <MessageActionsRow
                    conversationId={selectedConversationId}
                    messageId={message.payload.messageId}
                    currentBody={message.payload.body}
                  />
                ) : null}
                {isLatest && message.payload.senderId === activeUserId && readBy.length > 0 ? (
                  <p className="message-read-receipt" aria-label="Read receipts">
                    Read by {readBy.length === 1
                      ? displayName(users, readBy[0]!.userId)
                      : `${readBy.length} others`}
                  </p>
                ) : null}
              </div>
            );
          })}
          {selectedMessages.length === 0 ? <p className="empty">No messages yet</p> : null}
          <div aria-hidden="true" ref={messagesEndRef} />
        </MessageList>
      </section>
    );
  }

  function renderChatComposer() {
    return (
      <FileDropzone
        accept="image/"
        onUpload={(metadata) => {
          setDraftAttachments((current) => [...current, metadata]);
          setAttachmentStatus(`Attached ${metadata.name} (${formatByteCount(metadata.byteLength)})`);
          setAttachmentError(undefined);
        }}
        onError={(error) => setAttachmentError(error.message)}
        options={{ maxDimension: 2048, quality: 0.85 }}
      >
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
        <input
          accept="image/*"
          aria-label="Upload image attachment"
          className="image-attach-input"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void attachImage(file);
            }
          }}
          ref={imageInputRef}
          type="file"
        />
        <IconButton
          className="attach-button image-attach-button"
          icon="paperclip"
          label={isUploadingAttachment ? "Uploading image" : "Attach image"}
          disabled={isUploadingAttachment}
          onClick={() => imageInputRef.current?.click()}
        />
        <VoiceMemoButton
          onUploaded={(metadata) => {
            setDraftAttachments((current) => [...current, metadata]);
            setAttachmentStatus(`Recorded ${metadata.name} (${formatByteCount(metadata.byteLength)})`);
          }}
          onError={(error) => setAttachmentError(error.message)}
        />
        <IconButton type="submit" icon="send" label="Send message" tone="primary" />
      </form>
      </FileDropzone>
    );
  }

  function renderSearchPanel() {
    return (
      <section className="panel search-panel">
        <PanelTitle icon={<MessageCircle size={18} />} title="Search" />
        <form
          className="search-form"
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch(searchQuery);
          }}
        >
          <TextField
            aria-label="Search messages"
            className="search-field"
            placeholder="Search messages..."
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          <Button className="secondary-action" type="submit" disabled={isSearching}>
            {isSearching ? "Searching..." : "Search"}
          </Button>
        </form>
        {searchError ? (
          <p className="search-error" role="alert">{searchError}</p>
        ) : null}
        <div className="search-results" aria-label="Search results">
          {searchResults.map((hit) => {
            const conversationId =
              typeof hit.fields.conversationId === "string" ? hit.fields.conversationId : undefined;
            const conversationLabel = conversationId
              ? conversationDisplayTitle({
                  activeUserId,
                  conversation: visibleConversations.find((c) => c.id === conversationId),
                  conversationId,
                  members: visibleMembers.filter((m) => m.conversationId === conversationId),
                  users,
                })
              : "Unknown thread";
            return (
              <button
                className="search-hit"
                key={hit.docId}
                onClick={() => jumpToSearchHit(hit)}
                type="button"
              >
                <strong>{conversationLabel}</strong>
                <small>{hit.docId}</small>
              </button>
            );
          })}
          {searchResults.length === 0 && !isSearching && !searchError ? (
            <p className="empty">No results</p>
          ) : null}
        </div>
      </section>
    );
  }

  function renderSettingsPanel() {
    const currentDisplayName = session.displayName ?? displayName(users, activeUserId);
    return (
      <section className="panel settings-panel">
        <PanelTitle icon={<Users size={18} />} title="Settings" />
        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveDisplayName();
          }}
        >
          <TextField
            aria-label="Display name"
            label="Display name"
            placeholder={currentDisplayName}
            value={displayNameDraft}
            onChange={(event) => {
              setDisplayNameDraft(event.target.value);
              setDisplayNameError(undefined);
              setDisplayNameStatus(undefined);
            }}
          />
          <Button
            className="secondary-action"
            disabled={isSavingDisplayName || displayNameDraft.trim().length === 0}
            type="submit"
          >
            {isSavingDisplayName ? "Saving..." : "Save display name"}
          </Button>
          {displayNameError ? (
            <p className="settings-error" role="alert">{displayNameError}</p>
          ) : null}
          {displayNameStatus ? (
            <p className="settings-status" role="status">{displayNameStatus}</p>
          ) : null}
        </form>
        <div className="settings-divider" aria-hidden="true" />
        <div className="push-toggle">
          <strong>Notifications</strong>
          <small>
            {pushRegistration
              ? `Registered (${pushRegistration.platform})`
              : "Not registered"}
          </small>
          <Button
            className="secondary-action"
            disabled={isTogglingPush}
            onClick={() => void togglePushRegistration()}
          >
            {isTogglingPush
              ? "Working..."
              : pushRegistration
                ? "Disable notifications"
                : "Enable notifications"}
          </Button>
          {pushError ? (
            <p className="settings-error" role="alert">{pushError}</p>
          ) : null}
        </div>
      </section>
    );
  }

  function renderChatInspector() {
    return (
      <div className="inspector-stack">
        {renderSearchPanel()}
        {renderSettingsPanel()}
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
    <>
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
      {/* Phase 2c — dev-only inspector. Renders nothing in production builds. */}
      <FrickDevtools enabled={isDevEnvironment()} />
    </>
  );
}

function isDevEnvironment(): boolean {
  // Vite's `import.meta.env.DEV` requires the `vite/client` types; rather
  // than thread those into the workspace typecheck just for one flag, ask
  // the browser whether we're on a dev-server host.
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host === "127.0.0.1" || host === "localhost";
}

/**
 * Pure projection: walk the conversation's events oldest-first, replace
 * the body of any `MessageSent` whose id appears in a later
 * `MessageEdited`, and replace the body of any redacted message with a
 * "Redacted" tombstone. Append-only on the wire; mutable for display.
 */
function applyMessageEdits(
  messages: ChatMessageEvent[],
  allEvents: ChatStreamEvent[],
): ChatMessageEvent[] {
  if (messages.length === 0) return messages;
  const edits = new Map<string, string>();
  const redactions = new Set<string>();
  for (const event of allEvents) {
    const payload = event.payload as Record<string, unknown>;
    const id = typeof payload.messageId === "string" ? payload.messageId : undefined;
    if (!id) continue;
    if (event.event === "MessageEdited" && typeof payload.body === "string") {
      edits.set(id, payload.body);
    } else if (event.event === "MessageRedacted") {
      redactions.add(id);
    }
  }
  return messages.map((message) => {
    const id = message.payload.messageId;
    if (redactions.has(id)) {
      return { ...message, payload: { ...message.payload, body: "🗑️ Redacted" } };
    }
    const edited = edits.get(id);
    if (edited !== undefined) {
      return { ...message, payload: { ...message.payload, body: edited } };
    }
    return message;
  });
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

/**
 * Phase 4 — edit / redact action row using `useMessageActions`. Owner-only.
 * Edit pops a `prompt()` for v1 simplicity; consumers wanting an inline
 * editor can replace this with their own UI — the hook surface stays the
 * same.
 */
function MessageActionsRow({
  conversationId,
  messageId,
  currentBody,
}: {
  conversationId: string;
  messageId: string;
  currentBody: string;
}) {
  const { edit, redact } = useMessageActions(conversationId, messageId);
  return (
    <div className="message-actions" aria-label="Message actions">
      <button
        type="button"
        className="message-action"
        onClick={() => {
          const next = window.prompt("Edit message", currentBody);
          if (next !== null && next !== currentBody) {
            void edit(next).catch(() => {/* surfaced via syncStatus.lastError */});
          }
        }}
      >
        Edit
      </button>
      <button
        type="button"
        className="message-action message-action-destructive"
        onClick={() => {
          if (window.confirm("Redact this message?")) {
            void redact().catch(() => {});
          }
        }}
      >
        Redact
      </button>
    </div>
  );
}

/**
 * Phase 4 — voice memo button. `useVoiceMemo` owns `getUserMedia` +
 * `MediaRecorder` + the upload-to-blob handshake; the demo only needs
 * to plumb the resulting `AttachmentMetadata` into its draft tray.
 */
function VoiceMemoButton({
  onUploaded,
  onError,
}: {
  onUploaded: (metadata: AttachmentMetadata) => void;
  onError: (error: Error) => void;
}) {
  const memo = useVoiceMemo();
  const label =
    memo.state === "recording"
      ? "Stop recording"
      : memo.state === "uploading"
      ? "Uploading…"
      : "Record voice memo";
  return (
    <IconButton
      className="attach-button voice-memo-button"
      icon="mic"
      label={label}
      data-active={memo.state === "recording"}
      disabled={memo.state === "uploading"}
      onClick={async () => {
        if (memo.state === "recording") {
          const metadata = await memo.stop();
          if (metadata) onUploaded(metadata);
          else if (memo.error) onError(memo.error);
        } else if (memo.state === "idle") {
          await memo.start();
          if (memo.error) onError(memo.error);
        }
      }}
    />
  );
}

/**
 * Phase 4 — message reactions row using `useReactions` from `@frick/react`.
 * Renders an emoji-count chip per distinct reaction; clicking the chip
 * toggles the active user's reaction via the hook's optimistic-append path.
 */
function MessageReactions({ conversationId, messageId }: { conversationId: string; messageId: string }) {
  const { reactions, react, unreact } = useReactions(conversationId, messageId);
  if (reactions.length === 0) return null;
  return (
    <ul className="message-reactions" aria-label="Reactions">
      {reactions.map((reaction) => (
        <li key={reaction.emoji}>
          <button
            type="button"
            className="reaction-chip"
            data-active={reaction.meReacted}
            onClick={() => (reaction.meReacted ? void unreact(reaction.emoji) : void react(reaction.emoji))}
          >
            <span aria-hidden="true">{reaction.emoji}</span>
            <span className="reaction-count">{reaction.userIds.length}</span>
          </button>
        </li>
      ))}
    </ul>
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

function syncStatusTone(
  status: { connected: boolean; authenticated: boolean },
): "green" | "yellow" | "red" {
  if (!status.connected) return "red";
  if (status.connected && !status.authenticated) return "yellow";
  return "green";
}

function syncStatusLabel(
  status: { connected: boolean; authenticated: boolean },
): string {
  if (!status.connected) return "Disconnected";
  if (!status.authenticated) return "Connected, awaiting auth";
  return "Connected and authenticated";
}

function syncStatusTooltip(
  status: { connected: boolean; authenticated: boolean; lastError?: { code?: string } },
): string {
  const base = syncStatusLabel(status);
  if (status.lastError?.code) {
    return `${base} (last error: ${status.lastError.code})`;
  }
  return base;
}

function readAttachmentBlobIds(message: ChatMessageEvent): string[] {
  const ids = (message.payload as { attachmentBlobIds?: unknown }).attachmentBlobIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((value): value is string => typeof value === "string");
}

function cssEscape(value: string): string {
  if (typeof window !== "undefined" && typeof window.CSS?.escape === "function") {
    return window.CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

function AttachmentThumbnail({
  blobId,
  httpEndpoint,
  sessionToken,
}: {
  blobId: string;
  httpEndpoint: string;
  sessionToken: string;
}) {
  const [objectUrl, setObjectUrl] = useState<string | undefined>();
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | undefined;
    setErrored(false);
    setObjectUrl(undefined);

    async function load() {
      // Try the thumbnail derivative first, fall back to the original blob.
      const candidates = [
        blobDerivativeUrl(httpEndpoint, blobId, "thumb"),
        `${httpEndpoint.replace(/\/$/, "")}/blobs/${encodeURIComponent(blobId)}/content`,
      ];
      for (const url of candidates) {
        try {
          const response = await fetch(url, {
            headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {},
          });
          if (!response.ok) continue;
          const blob = await response.blob();
          if (cancelled) return;
          createdUrl = URL.createObjectURL(blob);
          setObjectUrl(createdUrl);
          return;
        } catch {
          // Try the next candidate.
        }
      }
      if (!cancelled) {
        setErrored(true);
      }
    }

    void load();
    return () => {
      cancelled = true;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [blobId, httpEndpoint, sessionToken]);

  if (errored) {
    return <span className="attachment-thumb attachment-thumb-error">[attachment]</span>;
  }
  if (!objectUrl) {
    return <span className="attachment-thumb attachment-thumb-pending" aria-label="Loading attachment" />;
  }
  return <img alt={`Attachment ${blobId}`} className="attachment-thumb" src={objectUrl} />;
}

const pushRegistrationStorageKey = "frick-web-push-registration";

function readStoredPushRegistration(): PushRegistration | undefined {
  const raw = window.localStorage.getItem(pushRegistrationStorageKey);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<PushRegistration>;
    if (typeof parsed.id === "string" && typeof parsed.deviceId === "string" && typeof parsed.platform === "string") {
      return parsed as PushRegistration;
    }
  } catch {
    window.localStorage.removeItem(pushRegistrationStorageKey);
  }
  return undefined;
}

function writeStoredPushRegistration(registration: PushRegistration): void {
  window.localStorage.setItem(pushRegistrationStorageKey, JSON.stringify(registration));
}

function clearStoredPushRegistration(): void {
  window.localStorage.removeItem(pushRegistrationStorageKey);
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
