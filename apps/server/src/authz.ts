export interface Principal {
  userId: string;
  deviceId: string;
  replicaId: string;
}

export interface MembershipReader {
  hasUser(userId: string): boolean;
  isRoomMember(conversationId: string, userId: string): boolean;
}

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export function principalFromHello(replicaId: string, deviceId: string): Principal {
  return {
    userId: userIdFromReplica(replicaId),
    deviceId,
    replicaId,
  };
}

export function principalFromUserId(userId: string, replicaId = "http", deviceId = "http"): Principal {
  return {
    userId,
    deviceId,
    replicaId,
  };
}

export function assertCanSubscribe(
  principal: Principal,
  kind: string,
  name: string,
  key: string | undefined,
  memberships: MembershipReader,
): void {
  if (kind === "stream" && name === "MessageStream") {
    assertMessageStreamMember(principal, key, memberships);
  }
}

export function assertCanAppend(
  principal: Principal,
  stream: string,
  key: string,
  memberships: MembershipReader,
  event?: string,
  payload?: Record<string, unknown>,
): void {
  if (stream !== "MessageStream") {
    return;
  }

  assertMessageStreamMember(principal, key, memberships);
  if (event === "MessageSent" && payload?.senderId !== principal.userId) {
    throw new AuthorizationError("MessageSent senderId must match the principal");
  }
  if (event === "ReceiptAdvanced" && payload?.userId !== principal.userId) {
    throw new AuthorizationError("ReceiptAdvanced userId must match the principal");
  }
}

export function assertCanSignal(_principal: Principal, _signal: string, _key: string): void {}

export function assertCanReadInbox(principal: Principal, userId: string, memberships: MembershipReader): void {
  if (userId !== principal.userId) {
    throw new AuthorizationError("Inbox userId must match the principal");
  }
  if (!memberships.hasUser(userId)) {
    throw new AuthorizationError(`Unknown inbox principal ${userId}`);
  }
}

function assertMessageStreamMember(principal: Principal, conversationId: string | undefined, memberships: MembershipReader): void {
  if (!conversationId || !memberships.isRoomMember(conversationId, principal.userId)) {
    throw new AuthorizationError(`${principal.userId} is not a member of ${conversationId ?? "the conversation"}`);
  }
}

function userIdFromReplica(replicaId: string): string {
  if (replicaId.includes("grace")) {
    return "user-grace";
  }
  if (replicaId.includes("mallory")) {
    return "user-mallory";
  }
  return "user-ada";
}
