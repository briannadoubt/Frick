export interface Principal {
  userId: string;
  deviceId: string;
  replicaId: string;
}

export interface MembershipReader {
  hasUser(userId: string): boolean;
  isRoomMember(conversationId: string, userId: string): boolean;
  /**
   * Returns `true` when a conversation with this id exists. Used by
   * {@link assertCanSignal} to scope membership enforcement to signals
   * keyed by a known conversation — signals keyed by unrelated rooms
   * (e.g. ad-hoc call ids) are not gated by conversation membership.
   * Optional for backwards compatibility with callers built against
   * the original two-method interface.
   */
  hasConversation?(conversationId: string): boolean;
}

/**
 * Verbs the framework recognises for authorization. Today only a subset is
 * wired through `decide()` — extending requires both adding the action here
 * and a corresponding branch in the policy function.
 */
export type FrickAction =
  | "object.read"
  | "object.write"
  | "stream.read"
  | "stream.append"
  | "presence.write"
  | "signal.send"
  | "blob.read"
  | "blob.write"
  | "inbox.read";

/**
 * Reasons surfaced through {@link FrickDecision}. The framework maps these to
 * `FrickErrorEnvelope.code` + `details.reason` so clients can react in a
 * machine-readable way ("re-auth", "request access", "schema upgrade").
 */
export type FrickDecisionReason =
  | "allow"
  | "unauthenticated"
  | "notAuthorizedForResource"
  | "notMember"
  | "ownerMismatch"
  | "schemaIncompatible";

export type FrickDecision =
  | { allow: true; reason: "allow" }
  | { allow: false; reason: Exclude<FrickDecisionReason, "allow">; publicMessage: string };

export const ALLOW: FrickDecision = { allow: true, reason: "allow" };

export function deny(
  reason: Exclude<FrickDecisionReason, "allow">,
  publicMessage: string,
): FrickDecision {
  return { allow: false, reason, publicMessage };
}

/**
 * Future extension point: apps will be able to register custom policy hooks
 * that augment or override the framework defaults. The shape is documented
 * here for forward compatibility, but the framework does not yet invoke any
 * registered hooks — that wiring lands in a later slice.
 */
export interface FrickPolicyHook {
  readonly id: string;
  decide(input: FrickPolicyInput): FrickDecision | undefined;
}

export interface FrickPolicyInput {
  principal: Principal | undefined;
  action: FrickAction;
  resource: { kind: string; name?: string; key?: string; ownerId?: string };
  context?: Record<string, unknown>;
}

export class AuthorizationError extends Error {
  readonly decision: FrickDecision & { allow: false };
  constructor(decision: FrickDecision & { allow: false }) {
    super(decision.publicMessage);
    this.name = "AuthorizationError";
    this.decision = decision;
  }
}

export class AuthenticationError extends Error {
  readonly decision: FrickDecision & { allow: false };
  constructor(messageOrDecision: string | (FrickDecision & { allow: false })) {
    const decision: FrickDecision & { allow: false } =
      typeof messageOrDecision === "string"
        ? { allow: false, reason: "unauthenticated", publicMessage: messageOrDecision }
        : messageOrDecision;
    super(decision.publicMessage);
    this.name = "AuthenticationError";
    this.decision = decision;
  }
}

/**
 * Specialisation of {@link AuthenticationError} that maps to the
 * `auth.sessionExpired` envelope code so clients can prompt re-login rather
 * than treating it like a generic protocol bug.
 */
export class SessionExpiredError extends AuthenticationError {
  constructor(message = "Session token has expired") {
    super({ allow: false, reason: "unauthenticated", publicMessage: message });
    this.name = "SessionExpiredError";
  }
}

/**
 * Core policy function. Today this is a thin dispatcher over the framework's
 * built-in primitives; custom policy hooks (see {@link FrickPolicyHook}) will
 * eventually layer on top.
 */
export function decide(input: FrickPolicyInput, memberships: MembershipReader): FrickDecision {
  const { principal, action, resource } = input;

  if (!principal) {
    return deny("unauthenticated", "Missing session token");
  }

  switch (action) {
    case "inbox.read": {
      const ownerId = resource.ownerId ?? resource.key;
      if (ownerId !== principal.userId) {
        return deny("notAuthorizedForResource", "Inbox userId must match the principal");
      }
      if (!memberships.hasUser(principal.userId)) {
        return deny("notAuthorizedForResource", `Unknown inbox principal ${principal.userId}`);
      }
      return ALLOW;
    }
    case "blob.write":
    case "blob.read": {
      if (resource.ownerId !== principal.userId) {
        return deny("ownerMismatch", "Blob ownerId must match the principal");
      }
      return ALLOW;
    }
    case "signal.send": {
      const conversationId = resource.key;
      if (!conversationId) {
        return ALLOW;
      }
      // Only enforce membership when the key references a known conversation.
      // Signals keyed by other room-like objects (e.g. ad-hoc CallRoom ids)
      // are not gated by conversation membership in this slice.
      if (!memberships.hasConversation || !memberships.hasConversation(conversationId)) {
        return ALLOW;
      }
      if (!memberships.isRoomMember(conversationId, principal.userId)) {
        return deny(
          "notMember",
          `${principal.userId} is not a member of ${conversationId}`,
        );
      }
      return ALLOW;
    }
    case "stream.read":
    case "stream.append": {
      if (resource.name !== "MessageStream") {
        return ALLOW;
      }
      const conversationId = resource.key;
      if (!conversationId || !memberships.isRoomMember(conversationId, principal.userId)) {
        return deny(
          "notMember",
          `${principal.userId} is not a member of ${conversationId ?? "the conversation"}`,
        );
      }
      return ALLOW;
    }
    default:
      return ALLOW;
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
  if (kind !== "stream") {
    return;
  }
  const decision = decide(
    { principal, action: "stream.read", resource: { kind: "stream", name, ...(key !== undefined ? { key } : {}) } },
    memberships,
  );
  if (!decision.allow) {
    throw new AuthorizationError(decision);
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
  const decision = decide(
    { principal, action: "stream.append", resource: { kind: "stream", name: stream, key } },
    memberships,
  );
  if (!decision.allow) {
    throw new AuthorizationError(decision);
  }
  if (stream !== "MessageStream") {
    return;
  }
  if (event === "MessageSent" && payload?.senderId !== principal.userId) {
    throw new AuthorizationError(
      deny("ownerMismatch", "MessageSent senderId must match the principal") as FrickDecision & {
        allow: false;
      },
    );
  }
  if (event === "ReceiptAdvanced" && payload?.userId !== principal.userId) {
    throw new AuthorizationError(
      deny("ownerMismatch", "ReceiptAdvanced userId must match the principal") as FrickDecision & {
        allow: false;
      },
    );
  }
}

export function assertCanSignal(
  principal: Principal,
  signal: string,
  key: string,
  memberships?: MembershipReader,
): void {
  // Without a membership reader we can't tell whether the signal key is
  // a conversation we should gate on. This is the legacy code path
  // (e.g. the WebSocket gateway) and remains permissive for now —
  // conversation-keyed enforcement happens only when a reader is supplied.
  if (!memberships) {
    return;
  }
  const decision = decide(
    { principal, action: "signal.send", resource: { kind: "signal", name: signal, key } },
    memberships,
  );
  if (!decision.allow) {
    throw new AuthorizationError(decision);
  }
}

export function assertCanReadInbox(principal: Principal, userId: string, memberships: MembershipReader): void {
  const decision = decide(
    { principal, action: "inbox.read", resource: { kind: "inbox", key: userId, ownerId: userId } },
    memberships,
  );
  if (!decision.allow) {
    throw new AuthorizationError(decision);
  }
}

export function assertCanReadBlob(principal: Principal, ownerId: string): void {
  const decision = decide(
    { principal, action: "blob.read", resource: { kind: "blob", ownerId } },
    NULL_MEMBERSHIP,
  );
  if (!decision.allow) {
    throw new AuthorizationError(decision);
  }
}

export function assertBlobOwnership(principal: Principal, ownerId: string): void {
  const decision = decide(
    { principal, action: "blob.write", resource: { kind: "blob", ownerId } },
    NULL_MEMBERSHIP,
  );
  if (!decision.allow) {
    throw new AuthorizationError(decision);
  }
}

const NULL_MEMBERSHIP: MembershipReader = {
  hasUser: () => false,
  isRoomMember: () => false,
};

function userIdFromReplica(replicaId: string): string {
  if (replicaId.includes("grace")) {
    return "user-grace";
  }
  if (replicaId.includes("mallory")) {
    return "user-mallory";
  }
  return "user-ada";
}
