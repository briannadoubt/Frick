import { DEFAULT_TENANT_ID } from "./tenant.js";

export interface Principal {
  userId: string;
  deviceId: string;
  replicaId: string;
  /**
   * Tenant the principal acts within. Every principal has a tenant; the
   * value is {@link DEFAULT_TENANT_ID} for legacy single-tenant deployments.
   * The framework pins the tenant at session-issuance time (signup, login,
   * dev-login) and re-derives it on every authenticated request from the
   * session's `tenant_id` column. Cross-tenant access is denied with
   * reason `tenantMismatch` (see {@link decide}).
   */
  tenantId: string;
  /**
   * Scope of authority. `"tenant"` (the default when omitted) means the
   * principal is bound to {@link Principal.tenantId} and `decide()` denies
   * any cross-tenant access. `"admin"` means the principal can act across
   * tenants — `decide()` skips the `tenantMismatch` check, though every
   * per-action policy still applies. Admin principals are constructed only
   * by the framework when a request bears the configured `FRICK_ADMIN_TOKEN`.
   */
  scope?: "tenant" | "admin";
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
 * Build a tenant-scoped {@link MembershipReader} over a {@link FrickStore}.
 * The returned reader silently restricts every query to the supplied
 * `tenantId`. Used by the HTTP and WebSocket request paths so a principal
 * cannot trick membership lookups into resolving against another tenant.
 *
 * Imported lazily by `server.ts`/`gateway.ts` to avoid a cyclic module
 * dependency on `store.ts`.
 */
export function tenantMembershipReader(
  store: {
    hasUser(tenantId: string, userId: string): boolean;
    isRoomMember(tenantId: string, conversationId: string, userId: string): boolean;
    hasConversation(tenantId: string, conversationId: string): boolean;
  },
  tenantId: string,
): MembershipReader {
  return {
    hasUser: (userId) => store.hasUser(tenantId, userId),
    isRoomMember: (conversationId, userId) => store.isRoomMember(tenantId, conversationId, userId),
    hasConversation: (conversationId) => store.hasConversation(tenantId, conversationId),
  };
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
  | "presence.read"
  | "presence.write"
  | "signal.send"
  | "signal.read"
  | "blob.read"
  | "blob.write"
  | "inbox.read"
  | "projection.read"
  | "search.query";

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
  | "schemaIncompatible"
  | "tenantMismatch";

export type FrickDecision =
  | { allow: true; reason: "allow" }
  | { allow: false; reason: Exclude<FrickDecisionReason, "allow">; publicMessage: string };

export const ALLOW: FrickDecision = { allow: true, reason: "allow" };

const FOUNDATION_DIRECT_WRITE_DENIED_OBJECTS = new Set([
  "RoomMember",
  "Conversation",
  "UserSession",
  "UserDevice",
  "CallRoom",
]);

const FOUNDATION_OWNER_SCOPED_OBJECTS = new Set(["MessageDraft", "ScheduledMessage"]);

export function deny(
  reason: Exclude<FrickDecisionReason, "allow">,
  publicMessage: string,
): FrickDecision {
  return { allow: false, reason, publicMessage };
}

/**
 * Apps can register policy hooks via `createFrickServer({ policyHooks })`.
 * Hooks run AFTER the framework's default decision and can only tighten
 * policy:
 *  - If the framework allowed, registered hooks run in registration order.
 *    The first hook returning a deny decision wins.
 *  - If the framework denied, hooks are skipped — apps cannot override
 *    framework denials.
 *  - Returning `null` means "no opinion" and lets the next hook (or the
 *    framework's allow) stand.
 *
 * Hooks are intentionally synchronous in v1 — async policy will be a
 * separate extension once we have a use case that needs it.
 */
export type FrickPolicyHook = (input: FrickPolicyInput) => FrickDecision | null;

export interface FrickPolicyInput {
  principal: Principal | undefined;
  action: FrickAction;
  resource: {
    kind: string;
    name?: string;
    key?: string;
    ownerId?: string;
    /**
     * Tenant the resource belongs to. Surfaced by callers that have already
     * looked up the resource (or its parent) and know its tenant scope. When
     * supplied and it differs from {@link Principal.tenantId}, {@link decide}
     * denies with reason `tenantMismatch`. Omit to skip the tenant check
     * (used when the storage lookup itself is already tenant-scoped, so a
     * cross-tenant request would have returned "not found" before reaching
     * authz).
     */
    tenantId?: string;
  };
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

  // Tenant boundary: when the resource declares a tenant, it must match the
  // principal's tenant. Callers whose storage lookups are already tenant-
  // scoped omit `resource.tenantId` and rely on "not found" to hide cross-
  // tenant resources from existence-leak.
  if (
    resource.tenantId !== undefined &&
    resource.tenantId !== principal.tenantId &&
    principal.scope !== "admin"
  ) {
    return deny(
      "tenantMismatch",
      `Resource belongs to a different tenant than ${principal.tenantId}`,
    );
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
    case "signal.send":
    case "signal.read":
      return decideSignalAccess(principal, resource.key, memberships);
    case "presence.read":
    case "presence.write":
      return decidePresenceAccess(
        principal,
        resource.name,
        resource.key,
        input.context?.value,
        memberships,
      );
    case "projection.read": {
      // Projection subscribe is allowed for any authenticated principal in
      // the same tenant. Per-projection app-level policy can tighten this
      // via a registered FrickPolicyHook.
      return ALLOW;
    }
    case "search.query": {
      // Search queries are allowed for any authenticated principal within
      // their own tenant. The route layer scopes results to
      // `principal.tenantId` and applies built-in membership filtering for
      // framework indexes such as `messages-fts`.
      return ALLOW;
    }
    case "object.write": {
      if (principal.scope === "admin") {
        return ALLOW;
      }
      const objectType = resource.name;
      if (!objectType) {
        return deny("notAuthorizedForResource", "Object type is required");
      }
      if (objectType === "User") {
        return decideSelfUserWrite(principal, resource.key, input.context?.value);
      }
      if (FOUNDATION_DIRECT_WRITE_DENIED_OBJECTS.has(objectType)) {
        return deny(
          "notAuthorizedForResource",
          `${objectType} objects must be written through framework routes`,
        );
      }
      if (FOUNDATION_OWNER_SCOPED_OBJECTS.has(objectType)) {
        return decideOwnerScopedObjectWrite(principal, objectType, input.context?.value, memberships);
      }
      // Custom app objects are app-owned and remain writable by authenticated
      // tenant users unless a policy hook tightens the decision.
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
      return deny("notAuthorizedForResource", "Action not authorized");
  }
}

function decideSignalAccess(
  principal: Principal,
  key: string | undefined,
  memberships: MembershipReader,
): FrickDecision {
  if (!key) {
    return ALLOW;
  }
  // Only enforce membership when the key references a known conversation.
  // Signals keyed by unrelated ad-hoc rooms remain allowed.
  if (!memberships.hasConversation || !memberships.hasConversation(key)) {
    return ALLOW;
  }
  if (!memberships.isRoomMember(key, principal.userId)) {
    return deny("notMember", `${principal.userId} is not a member of ${key}`);
  }
  return ALLOW;
}

function decidePresenceAccess(
  principal: Principal,
  name: string | undefined,
  key: string | undefined,
  value: unknown,
  memberships: MembershipReader,
): FrickDecision {
  if (name !== "TypingState") {
    return ALLOW;
  }
  const resource = typingStateResource(key, value);
  for (const ownerId of resource.userIds) {
    if (ownerId !== principal.userId) {
      return deny("ownerMismatch", "TypingState userId must match the principal");
    }
  }
  for (const conversationId of resource.conversationIds) {
    if (
      memberships.hasConversation?.(conversationId) &&
      !memberships.isRoomMember(conversationId, principal.userId)
    ) {
      return deny("notMember", `${principal.userId} is not a member of ${conversationId}`);
    }
  }
  return ALLOW;
}

function typingStateResource(
  key: string | undefined,
  value: unknown,
): { conversationIds: Set<string>; userIds: Set<string> } {
  const conversationIds = new Set<string>();
  const userIds = new Set<string>();
  if (key) {
    const [conversationId, userId] = key.split(":");
    if (conversationId) conversationIds.add(conversationId);
    if (userId) userIds.add(userId);
  }
  if (isRecord(value)) {
    if (typeof value.conversationId === "string") {
      conversationIds.add(value.conversationId);
    }
    if (typeof value.userId === "string") {
      userIds.add(value.userId);
    }
  }
  return { conversationIds, userIds };
}

function decideSelfUserWrite(
  principal: Principal,
  objectId: string | undefined,
  value: unknown,
): FrickDecision {
  if (objectId !== principal.userId) {
    return deny("ownerMismatch", "User object id must match the principal");
  }
  if (!isRecord(value)) {
    return deny("notAuthorizedForResource", "User value must be an object");
  }
  if (typeof value.id === "string" && value.id !== principal.userId) {
    return deny("ownerMismatch", "User value id must match the principal");
  }
  return ALLOW;
}

function decideOwnerScopedObjectWrite(
  principal: Principal,
  objectType: string,
  value: unknown,
  memberships: MembershipReader,
): FrickDecision {
  if (!isRecord(value)) {
    return deny("notAuthorizedForResource", `${objectType} value must be an object`);
  }
  const ownerId = typeof value.userId === "string" ? value.userId : undefined;
  if (ownerId !== principal.userId) {
    return deny("ownerMismatch", `${objectType} userId must match the principal`);
  }
  const conversationId =
    typeof value.conversationId === "string" ? value.conversationId : undefined;
  if (
    !conversationId ||
    !memberships.hasConversation ||
    !memberships.hasConversation(conversationId) ||
    !memberships.isRoomMember(conversationId, principal.userId)
  ) {
    return deny(
      "notMember",
      `${principal.userId} is not a member of ${conversationId ?? "the conversation"}`,
    );
  }
  return ALLOW;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Runs registered policy hooks after the framework's default decision. See
 * {@link FrickPolicyHook} for the semantics.
 */
export function applyPolicyHooks(
  baseline: FrickDecision,
  input: FrickPolicyInput,
  hooks: readonly FrickPolicyHook[] | undefined,
): FrickDecision {
  if (!baseline.allow || !hooks || hooks.length === 0) {
    return baseline;
  }
  for (const hook of hooks) {
    const verdict = hook(input);
    if (verdict && !verdict.allow) {
      return verdict;
    }
  }
  return baseline;
}

function decideWithHooks(
  input: FrickPolicyInput,
  memberships: MembershipReader,
  hooks: readonly FrickPolicyHook[] | undefined,
): FrickDecision {
  return applyPolicyHooks(decide(input, memberships), input, hooks);
}

export function principalFromHello(
  replicaId: string,
  deviceId: string,
  tenantId: string = DEFAULT_TENANT_ID,
): Principal {
  return {
    userId: userIdFromReplica(replicaId),
    deviceId,
    replicaId,
    tenantId,
  };
}

export function principalFromUserId(
  userId: string,
  replicaId = "http",
  deviceId = "http",
  tenantId: string = DEFAULT_TENANT_ID,
): Principal {
  return {
    userId,
    deviceId,
    replicaId,
    tenantId,
  };
}

export function assertCanSubscribe(
  principal: Principal,
  kind: string,
  name: string,
  key: string | undefined,
  memberships: MembershipReader,
  hooks?: readonly FrickPolicyHook[],
): void {
  if (kind === "projection") {
    const decision = decideWithHooks(
      {
        principal,
        action: "projection.read",
        resource: { kind: "projection", name, ...(key !== undefined ? { key } : {}) },
      },
      memberships,
      hooks,
    );
    if (!decision.allow) {
      throw new AuthorizationError(decision);
    }
    return;
  }
  if (kind === "signal") {
    const decision = decideWithHooks(
      {
        principal,
        action: "signal.read",
        resource: { kind: "signal", name, ...(key !== undefined ? { key } : {}) },
      },
      memberships,
      hooks,
    );
    if (!decision.allow) {
      throw new AuthorizationError(decision);
    }
    return;
  }
  if (kind === "presence") {
    const decision = decideWithHooks(
      {
        principal,
        action: "presence.read",
        resource: { kind: "presence", name, ...(key !== undefined ? { key } : {}) },
      },
      memberships,
      hooks,
    );
    if (!decision.allow) {
      throw new AuthorizationError(decision);
    }
    return;
  }
  if (kind !== "stream") {
    return;
  }
  const decision = decideWithHooks(
    { principal, action: "stream.read", resource: { kind: "stream", name, ...(key !== undefined ? { key } : {}) } },
    memberships,
    hooks,
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
  hooks?: readonly FrickPolicyHook[],
): void {
  const decision = decideWithHooks(
    { principal, action: "stream.append", resource: { kind: "stream", name: stream, key } },
    memberships,
    hooks,
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

export function assertCanWriteObject(
  principal: Principal,
  objectType: string,
  objectId: string,
  memberships: MembershipReader,
  hooks?: readonly FrickPolicyHook[],
  value?: Record<string, unknown>,
): void {
  const decision = decideWithHooks(
    {
      principal,
      action: "object.write",
      resource: { kind: "object", name: objectType, key: objectId, tenantId: principal.tenantId },
      ...(value !== undefined ? { context: { value } } : {}),
    },
    memberships,
    hooks,
  );
  if (!decision.allow) {
    throw new AuthorizationError(decision);
  }
}

export function assertCanWritePresence(
  principal: Principal,
  presence: string,
  key: string,
  memberships: MembershipReader,
  hooks?: readonly FrickPolicyHook[],
  value?: Record<string, unknown>,
): void {
  const decision = decideWithHooks(
    {
      principal,
      action: "presence.write",
      resource: { kind: "presence", name: presence, key },
      ...(value !== undefined ? { context: { value } } : {}),
    },
    memberships,
    hooks,
  );
  if (!decision.allow) {
    throw new AuthorizationError(decision);
  }
}

export function assertCanQuerySearch(
  principal: Principal,
  indexName: string,
  memberships: MembershipReader,
  hooks?: readonly FrickPolicyHook[],
): void {
  const decision = decideWithHooks(
    {
      principal,
      action: "search.query",
      resource: { kind: "search", name: indexName, tenantId: principal.tenantId },
    },
    memberships,
    hooks,
  );
  if (!decision.allow) {
    throw new AuthorizationError(decision);
  }
}

export function assertCanReadSignal(
  principal: Principal,
  signal: string,
  key: string,
  memberships: MembershipReader,
  hooks?: readonly FrickPolicyHook[],
): void {
  const decision = decideWithHooks(
    { principal, action: "signal.read", resource: { kind: "signal", name: signal, key } },
    memberships,
    hooks,
  );
  if (!decision.allow) {
    throw new AuthorizationError(decision);
  }
}

export function assertCanSignal(
  principal: Principal,
  signal: string,
  key: string,
  memberships?: MembershipReader,
  hooks?: readonly FrickPolicyHook[],
): void {
  // Without a membership reader we can't tell whether the signal key is
  // a conversation we should gate on. This is the legacy code path
  // (e.g. the WebSocket gateway) and remains permissive for now —
  // conversation-keyed enforcement happens only when a reader is supplied.
  if (!memberships) {
    return;
  }
  const decision = decideWithHooks(
    { principal, action: "signal.send", resource: { kind: "signal", name: signal, key } },
    memberships,
    hooks,
  );
  if (!decision.allow) {
    throw new AuthorizationError(decision);
  }
}

export function assertCanReadInbox(
  principal: Principal,
  userId: string,
  memberships: MembershipReader,
  hooks?: readonly FrickPolicyHook[],
): void {
  const decision = decideWithHooks(
    { principal, action: "inbox.read", resource: { kind: "inbox", key: userId, ownerId: userId } },
    memberships,
    hooks,
  );
  if (!decision.allow) {
    throw new AuthorizationError(decision);
  }
}

export function assertCanReadBlob(
  principal: Principal,
  ownerId: string,
  hooks?: readonly FrickPolicyHook[],
): void {
  const decision = decideWithHooks(
    { principal, action: "blob.read", resource: { kind: "blob", ownerId } },
    NULL_MEMBERSHIP,
    hooks,
  );
  if (!decision.allow) {
    throw new AuthorizationError(decision);
  }
}

export function assertBlobOwnership(
  principal: Principal,
  ownerId: string,
  hooks?: readonly FrickPolicyHook[],
): void {
  const decision = decideWithHooks(
    { principal, action: "blob.write", resource: { kind: "blob", ownerId } },
    NULL_MEMBERSHIP,
    hooks,
  );
  if (!decision.allow) {
    throw new AuthorizationError(decision);
  }
}

const NULL_MEMBERSHIP: MembershipReader = {
  hasUser: () => false,
  isRoomMember: () => false,
  hasConversation: () => false,
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
