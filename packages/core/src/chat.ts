import type { FrickErrorEnvelope, PlainObject, StreamEventInput } from "@frick/protocol";

export type User = PlainObject & {
  id: string;
  displayName: string;
};

export type Conversation = PlainObject & {
  id: string;
  title?: string;
  kind: string;
  createdBy?: string;
};

export type RoomMember = PlainObject & {
  id: string;
  conversationId: string;
  userId: string;
  role: "owner" | "member";
};

export type AttachmentMetadata = PlainObject & {
  blobId: string;
  name: string;
  byteLength: number;
  mimeType: string;
  contentHash: string;
};

export type DemoAttachment = AttachmentMetadata & {
  bytes: Uint8Array;
};

export type BlobMetadataCreatePayload = PlainObject & {
  blobId: string;
  ownerId: string;
  contentHash: string;
  byteLength: number;
  mimeType: string;
  storageKey?: string;
};

export type SyncedBlobMetadata = BlobMetadataCreatePayload & {
  createdAt: string;
};

export type ChatMessageEvent = StreamEventInput & {
  event: "MessageSent";
  payload: {
    messageId: string;
    senderId: string;
    body: string;
    createdAt: string;
    attachmentBlobIds?: string[];
  };
};

export type ChatStreamEvent = StreamEventInput & {
  payload: PlainObject;
};

type FetchImpl = (input: URL, init?: RequestInit) => Promise<Response>;
const defaultAuthRequestTimeoutMs = 10_000;

export interface AuthSession {
  schemaHash: string;
  sessionToken: string;
  userId: string;
  deviceId: string;
  replicaId: string;
  expiresAt: string;
  displayName?: string;
  handle?: string;
}

export interface FrickHttpErrorBody {
  error?: FrickErrorEnvelope;
  message?: string;
}

export type DevSession = AuthSession;

export type InboxRow = PlainObject & {
  conversationId: string;
  userId?: string;
  title?: string;
  kind?: string;
  lastSequence?: number;
  readSequence?: number;
  unreadCount?: number;
  preview?: string;
  lastMessagePreview?: string;
  lastMessageBody?: string;
  lastMessageAt?: string;
  updatedAt?: string;
};

export interface InboxItem {
  conversationId: string;
  title: string;
  kind: string;
  preview: string;
  lastSequence: number;
  readSequence: number;
  unreadCount: number;
  selected: boolean;
  remote: boolean;
}

export interface CreatedConversationResponse {
  schemaHash: string;
  conversation: Conversation;
  member: RoomMember;
  members: RoomMember[];
}

export interface SearchHit {
  docId: string;
  score: number;
  fields: Record<string, string | number>;
}

export interface SearchResponse {
  schemaHash: string;
  index: string;
  hits: SearchHit[];
  total: number;
}

export interface PushRegistration {
  registrationId: string;
  deviceId: string;
  platform: string;
  environment?: string;
}

export interface PushRegistrationResponse {
  registration: PushRegistration;
}

/** Selects the rows from a `useProjection` Map that belong to `userId`. */
export function projectionInboxRowsForUser(
  rows: Map<string, InboxRow>,
  userId: string,
): InboxRow[] {
  const filtered: InboxRow[] = [];
  for (const [key, row] of rows) {
    if (row.userId === userId) {
      filtered.push(row);
      continue;
    }
    // Server keys rows as `${userId}:${conversationId}`; fall back to the key
    // when the projection payload doesn't echo userId.
    if (!row.userId && key.startsWith(`${userId}:`)) {
      filtered.push({ ...row, userId });
    }
  }
  return filtered;
}

/**
 * Per-conversation "read by" map derived from the inbox projection. For each
 * member, returns the highest sequence they have acknowledged (their
 * `readSequence`). Senders don't see themselves in the result.
 */
export function readReceiptsForConversation(input: {
  conversationId: string;
  members: RoomMember[];
  inboxRows: InboxRow[];
  activeUserId: string;
}): { userId: string; readSequence: number }[] {
  const sequenceByUser = new Map<string, number>();
  for (const row of input.inboxRows) {
    if (row.conversationId !== input.conversationId) continue;
    if (!row.userId) continue;
    if (typeof row.readSequence !== "number") continue;
    sequenceByUser.set(row.userId, row.readSequence);
  }
  const result: { userId: string; readSequence: number }[] = [];
  for (const member of input.members) {
    if (member.conversationId !== input.conversationId) continue;
    if (member.userId === input.activeUserId) continue;
    const readSequence = sequenceByUser.get(member.userId) ?? 0;
    result.push({ userId: member.userId, readSequence });
  }
  return result;
}

export function sentMessageEvents(events: ChatStreamEvent[]): ChatMessageEvent[] {
  return events.filter((event): event is ChatMessageEvent => {
    const payload = event.payload as Partial<ChatMessageEvent["payload"]>;
    return (
      event.event === "MessageSent" &&
      typeof payload.messageId === "string" &&
      typeof payload.senderId === "string" &&
      typeof payload.body === "string" &&
      typeof payload.createdAt === "string"
    );
  });
}

export function deriveInboxItems(input: {
  conversations: Conversation[];
  inboxRows: InboxRow[] | undefined;
  localMessages: ChatMessageEvent[];
  selectedConversationId: string;
  readSequences: Record<string, number>;
}): InboxItem[] {
  const conversationById = new Map(input.conversations.map((conversation) => [conversation.id, conversation]));
  const rowByConversation = new Map((input.inboxRows ?? []).map((row) => [row.conversationId, row]));
  const orderedIds = unique([
    input.selectedConversationId,
    ...input.conversations.map((conversation) => conversation.id),
    ...(input.inboxRows ?? []).map((row) => row.conversationId),
  ]);

  return orderedIds.map((conversationId) => {
    const conversation = conversationById.get(conversationId);
    const row = rowByConversation.get(conversationId);
    const localMessages =
      conversationId === input.selectedConversationId
        ? input.localMessages.filter((message) => message.streamId === conversationId)
        : [];
    const lastLocalMessage = localMessages.at(-1);
    const lastLocalSequence = lastLocalMessage?.sequence ?? 0;
    const remoteLastSequence = row?.lastSequence ?? 0;
    const lastSequence = Math.max(remoteLastSequence, lastLocalSequence);
    const readSequence = Math.max(row?.readSequence ?? 0, input.readSequences[conversationId] ?? 0);
    const unreadCount =
      localMessages.length > 0
        ? localMessages.filter((message) => message.sequence > readSequence).length
        : typeof row?.unreadCount === "number"
        ? row.unreadCount
        : 0;

    return {
      conversationId,
      title: row?.title?.trim() || conversationTitle(conversation, conversationId),
      kind: row?.kind ?? conversation?.kind ?? "channel",
      preview: inboxPreview(row, lastLocalMessage),
      lastSequence,
      readSequence,
      unreadCount,
      selected: conversationId === input.selectedConversationId,
      remote: Boolean(row),
    };
  });
}

export function nextReadReceiptPayload(input: {
  userId: string;
  messages: ChatMessageEvent[];
  lastSentSequence: number;
}): { userId: string; sequence: number } | null {
  const latestSequence = input.messages.reduce((latest, message) => Math.max(latest, message.sequence), 0);
  if (latestSequence <= input.lastSentSequence) {
    return null;
  }
  return { userId: input.userId, sequence: latestSequence };
}

export async function computeSha256ContentHash(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto SHA-256 is unavailable");
  }

  const digest = await globalThis.crypto.subtle.digest("SHA-256", arrayBufferCopy(bytes));
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256-${hex}`;
}

export async function buildDemoAttachment(): Promise<DemoAttachment> {
  const bytes = new TextEncoder().encode(
    "Frick demo attachment\nThis file is uploaded through the blob content endpoint.\n",
  );

  return {
    blobId: `blob-demo-${crypto.randomUUID()}`,
    name: "demo-notes.txt",
    byteLength: bytes.byteLength,
    mimeType: "text/plain",
    contentHash: await computeSha256ContentHash(bytes),
    bytes,
  };
}

export function createBlobMetadataPayload(
  attachment: AttachmentMetadata,
  ownerId: string,
): BlobMetadataCreatePayload {
  return {
    blobId: attachment.blobId,
    ownerId,
    contentHash: attachment.contentHash,
    byteLength: attachment.byteLength,
    mimeType: attachment.mimeType,
  };
}

export async function syncDemoAttachmentMetadata({
  httpEndpoint,
  attachment,
  ownerId,
  sessionToken,
  fetchImpl = fetch,
}: {
  httpEndpoint: string;
  attachment: AttachmentMetadata;
  ownerId: string;
  sessionToken?: string | undefined;
  fetchImpl?: FetchImpl | undefined;
}): Promise<SyncedBlobMetadata | undefined> {
  const createResponse = await fetchImpl(frickHttpUrl(httpEndpoint, "blobs"), {
    method: "POST",
    headers: authorizedHeaders(sessionToken, { "content-type": "application/json" }),
    body: JSON.stringify(createBlobMetadataPayload(attachment, ownerId)),
  });

  if (!createResponse.ok) {
    throw new Error(`Blob metadata create returned ${createResponse.status}`);
  }

  const readResponse = await fetchImpl(frickHttpUrl(httpEndpoint, `blobs/${encodeURIComponent(attachment.blobId)}`), {
    headers: authorizedHeaders(sessionToken),
  });
  if (readResponse.status === 404) {
    return undefined;
  }
  if (!readResponse.ok) {
    throw new Error(`Blob metadata read returned ${readResponse.status}`);
  }
  return (await readResponse.json()) as SyncedBlobMetadata;
}

export async function syncDemoAttachment({
  httpEndpoint,
  attachment,
  ownerId,
  downloadContent = false,
  sessionToken,
  fetchImpl = fetch,
}: {
  httpEndpoint: string;
  attachment: DemoAttachment;
  ownerId: string;
  downloadContent?: boolean;
  sessionToken?: string | undefined;
  fetchImpl?: FetchImpl | undefined;
}): Promise<{ metadata: BlobMetadataCreatePayload; downloadedBytes?: Uint8Array }> {
  const metadata = createBlobMetadataPayload(attachment, ownerId);
  const metadataResponse = await fetchImpl(frickHttpUrl(httpEndpoint, "blobs"), {
    method: "POST",
    headers: authorizedHeaders(sessionToken, { "content-type": "application/json" }),
    body: JSON.stringify(metadata),
  });

  if (!metadataResponse.ok) {
    throw new Error(`Blob metadata create returned ${metadataResponse.status}`);
  }

  const contentUrl = frickHttpUrl(httpEndpoint, `blobs/${encodeURIComponent(attachment.blobId)}/content`);
  const uploadResponse = await fetchImpl(contentUrl, {
    method: "PUT",
    headers: authorizedHeaders(sessionToken, { "content-type": attachment.mimeType }),
    body: arrayBufferCopy(attachment.bytes),
  });

  if (!uploadResponse.ok) {
    throw new Error(`Blob content upload returned ${uploadResponse.status}`);
  }

  if (!downloadContent) {
    return { metadata };
  }

  const downloadResponse = await fetchImpl(contentUrl, {
    headers: authorizedHeaders(sessionToken),
  });
  if (!downloadResponse.ok) {
    throw new Error(`Blob content download returned ${downloadResponse.status}`);
  }

  return {
    metadata,
    downloadedBytes: new Uint8Array(await downloadResponse.arrayBuffer()),
  };
}

export async function postHttpSignal<TSignal extends PlainObject>({
  httpEndpoint,
  name,
  key,
  signal,
  sessionToken,
  fetchImpl = fetch,
}: {
  httpEndpoint: string;
  name: string;
  key: string;
  signal: TSignal;
  sessionToken?: string | undefined;
  fetchImpl?: FetchImpl | undefined;
}): Promise<void> {
  const response = await fetchImpl(signalUrl(httpEndpoint, name, key), {
    method: "POST",
    headers: authorizedHeaders(sessionToken, { "content-type": "application/json" }),
    body: JSON.stringify(signal),
  });

  if (!response.ok) {
    throw new Error(`Signal post returned ${response.status}`);
  }
}

export async function drainHttpSignals<TSignal extends PlainObject = PlainObject>({
  httpEndpoint,
  name,
  key,
  sessionToken,
  fetchImpl = fetch,
}: {
  httpEndpoint: string;
  name: string;
  key: string;
  sessionToken?: string | undefined;
  fetchImpl?: FetchImpl | undefined;
}): Promise<TSignal[]> {
  const response = await fetchImpl(signalUrl(httpEndpoint, name, key), {
    headers: authorizedHeaders(sessionToken),
  });
  if (!response.ok) {
    throw new Error(`Signal drain returned ${response.status}`);
  }

  const body = await response.json();
  const signals = Array.isArray(body) ? body : signalEnvelopeData(body);
  if (!signals) {
    throw new Error("Signal drain returned invalid JSON");
  }
  return signals as TSignal[];
}

export async function searchMessages({
  httpEndpoint,
  q,
  conversationId,
  sessionToken,
  limit = 50,
  fetchImpl = fetch,
}: {
  httpEndpoint: string;
  q: string;
  conversationId?: string | undefined;
  sessionToken?: string | undefined;
  limit?: number | undefined;
  fetchImpl?: FetchImpl | undefined;
}): Promise<SearchResponse> {
  const body: Record<string, unknown> = {
    index: "messages-fts",
    q,
    limit,
  };
  if (conversationId) {
    body.filter = { conversationId };
  }
  const response = await fetchImpl(frickHttpUrl(httpEndpoint, "search"), {
    method: "POST",
    headers: authorizedHeaders(sessionToken, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await authErrorMessage(response, "Search"));
  }
  return (await response.json()) as SearchResponse;
}

export async function registerPushDevice({
  httpEndpoint,
  deviceId,
  token,
  platform = "test",
  environment = "production",
  sessionToken,
  fetchImpl = fetch,
}: {
  httpEndpoint: string;
  deviceId: string;
  token: string;
  platform?: string | undefined;
  environment?: "production" | "sandbox" | undefined;
  sessionToken?: string | undefined;
  fetchImpl?: FetchImpl | undefined;
}): Promise<PushRegistration> {
  const response = await fetchImpl(frickHttpUrl(httpEndpoint, "push/registrations"), {
    method: "POST",
    headers: authorizedHeaders(sessionToken, { "content-type": "application/json" }),
    body: JSON.stringify({ deviceId, token, platform, environment }),
  });
  if (!response.ok) {
    throw new Error(await authErrorMessage(response, "Push registration"));
  }
  const json = (await response.json()) as PushRegistrationResponse;
  return json.registration;
}

export async function revokePushDevice({
  httpEndpoint,
  registrationId,
  sessionToken,
  fetchImpl = fetch,
}: {
  httpEndpoint: string;
  registrationId: string;
  sessionToken?: string | undefined;
  fetchImpl?: FetchImpl | undefined;
}): Promise<void> {
  const response = await fetchImpl(
    frickHttpUrl(httpEndpoint, `push/registrations/${encodeURIComponent(registrationId)}`),
    {
      method: "DELETE",
      headers: authorizedHeaders(sessionToken),
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(await authErrorMessage(response, "Push revoke"));
  }
}

export async function uploadImageAttachment({
  httpEndpoint,
  file,
  ownerId,
  sessionToken,
  fetchImpl = fetch,
}: {
  httpEndpoint: string;
  file: File;
  ownerId: string;
  sessionToken?: string | undefined;
  fetchImpl?: FetchImpl | undefined;
}): Promise<AttachmentMetadata> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentHash = await computeSha256ContentHash(bytes);
  const mimeType = file.type || "application/octet-stream";
  const blobId = `blob-img-${crypto.randomUUID()}`;
  const metadata: AttachmentMetadata = {
    blobId,
    name: file.name || "attachment",
    byteLength: bytes.byteLength,
    mimeType,
    contentHash,
  };
  const metadataResponse = await fetchImpl(frickHttpUrl(httpEndpoint, "blobs"), {
    method: "POST",
    headers: authorizedHeaders(sessionToken, { "content-type": "application/json" }),
    body: JSON.stringify(createBlobMetadataPayload(metadata, ownerId)),
  });
  if (!metadataResponse.ok) {
    throw new Error(await authErrorMessage(metadataResponse, "Blob metadata"));
  }
  const contentUrl = frickHttpUrl(
    httpEndpoint,
    `blobs/${encodeURIComponent(blobId)}/content?ownerId=${encodeURIComponent(ownerId)}`,
  );
  const uploadResponse = await fetchImpl(contentUrl, {
    method: "PUT",
    headers: authorizedHeaders(sessionToken, { "content-type": mimeType }),
    body: arrayBufferCopy(bytes),
  });
  if (!uploadResponse.ok) {
    throw new Error(await authErrorMessage(uploadResponse, "Blob upload"));
  }
  return metadata;
}

export function blobContentUrl(httpEndpoint: string, blobId: string): string {
  const base = httpEndpoint.replace(/\/$/, "");
  return `${base}/blobs/${encodeURIComponent(blobId)}/content`;
}

export function blobDerivativeUrl(
  httpEndpoint: string,
  blobId: string,
  derivative: string,
): string {
  const base = httpEndpoint.replace(/\/$/, "");
  return `${base}/blobs/${encodeURIComponent(blobId)}/derivatives/${encodeURIComponent(derivative)}/content`;
}

export async function createConversation({
  httpEndpoint,
  title,
  kind,
  participantUserIds,
  sessionToken,
  fetchImpl = fetch,
}: {
  httpEndpoint: string;
  title?: string | undefined;
  kind?: "dm" | "group" | "channel" | undefined;
  participantUserIds?: string[] | undefined;
  sessionToken?: string | undefined;
  fetchImpl?: FetchImpl | undefined;
}): Promise<CreatedConversationResponse> {
  const body = {
    ...(title !== undefined ? { title } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(participantUserIds !== undefined ? { participantUserIds } : {}),
  };
  const response = await fetchImpl(frickHttpUrl(httpEndpoint, "conversations"), {
    method: "POST",
    headers: authorizedHeaders(sessionToken, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await authErrorMessage(response, "Conversation create"));
  }

  return (await response.json()) as CreatedConversationResponse;
}

export async function devLogin({
  httpEndpoint,
  userId,
  deviceId,
  replicaId,
  platform,
  fetchImpl = fetch,
}: {
  httpEndpoint: string;
  userId: string;
  deviceId?: string | undefined;
  replicaId?: string | undefined;
  platform?: string | undefined;
  fetchImpl?: FetchImpl | undefined;
}): Promise<AuthSession> {
  const response = await fetchImpl(frickHttpUrl(httpEndpoint, "auth/dev-login"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, deviceId, replicaId, platform }),
  });

  if (!response.ok) {
    throw new Error(`Dev login returned ${response.status}`);
  }

  return (await response.json()) as AuthSession;
}

export async function signUp({
  httpEndpoint,
  displayName,
  handle,
  password,
  deviceId,
  replicaId,
  platform,
  fetchImpl = fetch,
  timeoutMs = defaultAuthRequestTimeoutMs,
}: {
  httpEndpoint: string;
  displayName: string;
  handle: string;
  password: string;
  deviceId?: string | undefined;
  replicaId?: string | undefined;
  platform?: string | undefined;
  fetchImpl?: FetchImpl | undefined;
  timeoutMs?: number | undefined;
}): Promise<AuthSession> {
  return postAuthSession({
    httpEndpoint,
    path: "/auth/signup",
    statusName: "Signup",
    body: { displayName, handle, password, deviceId, replicaId, platform },
    fetchImpl,
    timeoutMs,
  });
}

export async function login({
  httpEndpoint,
  identity,
  password,
  deviceId,
  replicaId,
  platform,
  fetchImpl = fetch,
  timeoutMs = defaultAuthRequestTimeoutMs,
}: {
  httpEndpoint: string;
  identity: string;
  password: string;
  deviceId?: string | undefined;
  replicaId?: string | undefined;
  platform?: string | undefined;
  fetchImpl?: FetchImpl | undefined;
  timeoutMs?: number | undefined;
}): Promise<AuthSession> {
  return postAuthSession({
    httpEndpoint,
    path: "/auth/login",
    statusName: "Login",
    body: { identity, password, deviceId, replicaId, platform },
    fetchImpl,
    timeoutMs,
  });
}

export function appendAttachmentMarker(body: string, attachments: AttachmentMetadata[]): string {
  const trimmed = body.trim();
  if (attachments.length === 0) {
    return trimmed;
  }
  const marker = attachments
    .map((attachment) => `[Attachment: ${attachment.name}, ${formatBytes(attachment.byteLength)}]`)
    .join("\n");
  return trimmed.length > 0 ? `${trimmed}\n\n${marker}` : marker;
}

function inboxPreview(row: InboxRow | undefined, lastLocalMessage: ChatMessageEvent | undefined): string {
  const preview = row?.preview ?? row?.lastMessagePreview ?? row?.lastMessageBody ?? lastLocalMessage?.payload.body;
  return preview && preview.trim().length > 0 ? preview : "No messages yet";
}

function conversationTitle(conversation: Conversation | undefined, conversationId: string): string {
  return conversation?.title?.trim() || titleFromId(conversationId);
}

function titleFromId(conversationId: string): string {
  return conversationId
    .replace(/^conversation-/, "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function signalEnvelopeData(value: unknown): PlainObject[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const data = (value as { data?: unknown }).data;
  return Array.isArray(data) ? (data as PlainObject[]) : undefined;
}

function arrayBufferCopy(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function formatBytes(byteLength: number): string {
  if (byteLength < 1024) {
    return `${byteLength} B`;
  }
  return `${Math.round(byteLength / 1024)} KB`;
}

function signalUrl(httpEndpoint: string, name: string, key: string): URL {
  return frickHttpUrl(httpEndpoint, `signals/${encodeURIComponent(name)}/${encodeURIComponent(key)}`);
}

function frickHttpUrl(httpEndpoint: string, path: string): URL {
  const baseUrl = `${httpEndpoint.replace(/\/$/, "")}/`;
  return new URL(path.replace(/^\/+/, ""), baseUrl);
}

async function postAuthSession({
  httpEndpoint,
  path,
  statusName,
  body,
  fetchImpl,
  timeoutMs,
}: {
  httpEndpoint: string;
  path: string;
  statusName: string;
  body: Record<string, string | undefined>;
  fetchImpl: FetchImpl;
  timeoutMs: number;
}): Promise<AuthSession> {
  const abortController = timeoutMs > 0 ? new AbortController() : undefined;
  const timeoutId =
    abortController === undefined
      ? undefined
      : setTimeout(() => {
          abortController.abort();
        }, timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(frickHttpUrl(httpEndpoint, path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withoutUndefined(body)),
      ...(abortController ? { signal: abortController.signal } : {}),
    });
  } catch (error) {
    if (abortController?.signal.aborted) {
      throw new Error(`${statusName} timed out`);
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }

  if (!response.ok) {
    throw new Error(await authErrorMessage(response, statusName));
  }

  return (await response.json()) as AuthSession;
}

async function authErrorMessage(response: Response, statusName: string): Promise<string> {
  try {
    const body = (await response.clone().json()) as FrickHttpErrorBody | unknown;
    if (body && typeof body === "object") {
      const error = "error" in body ? body.error : undefined;
      if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
        return error.message;
      }
      if ("message" in body && typeof body.message === "string") {
        return body.message;
      }
    }
  } catch {
    // Fall back to the status line when the server did not return JSON.
  }
  return `${statusName} returned ${response.status}`;
}

function authorizedHeaders(sessionToken: string | undefined, headers: Record<string, string> = {}): Record<string, string> {
  if (!sessionToken) {
    return headers;
  }
  return {
    ...headers,
    Authorization: `Bearer ${sessionToken}`,
  };
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function withoutUndefined(input: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
