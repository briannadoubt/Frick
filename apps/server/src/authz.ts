import type { FrickSharingPermission } from "@frick/protocol";
import { DEFAULT_TENANT_ID } from "./tenant.js";
import type { FrickSearchIndexDefinition } from "./search/types.js";

/**
 * Hook the framework's authorization flow uses to consult cross-user
 * sharing grants. Returns `true` iff `granteeUserId` holds a non-revoked
 * grant on `(recordType, recordId)` within `tenantId` whose permission
 * satisfies `required`. The implementation is supplied by the server's
 * {@link GrantStore}; passed as a plain function so authz stays decoupled
 * from storage.
 *
 * The framework calls this only after the baseline decision (and any
 * registered policy hooks) have produced a deny on `object.read` /
 * `object.write` with reason `notAuthorizedForResource` or `ownerMismatch`.
 * A grant lookup that returns true flips the decision back to allow; any
 * other deny reason (e.g. tenantMismatch) is left untouched.
 */
export type FrickGrantLookup = (args: {
  tenantId: string;
  granteeUserId: string;
  recordType: string;
  recordId: string;
  required: FrickSharingPermission;
}) => boolean;

/**
 * Cascade variant of {@link FrickGrantLookup} used by stream + projection
 * reads (FR-70). A grant is always issued against a specific object record
 * `(recordType, recordId)`, but a shared object's data also surfaces through
 * the stream and projection rows derived from it. Streams and projections are
 * not keyed by object *type* — they are keyed by an id (`streamId` for a
 * stream, the projection `key`). The framework therefore cascades read access
 * by *record id*: a grantee who holds an active, read-satisfying grant on any
 * object record whose `recordId` equals the stream's `streamId` (or the
 * projection's `key`) within the same tenant may read that stream / projection
 * row.
 *
 * Returns `true` iff such a grant exists. Implemented by the server's
 * {@link GrantStore} and passed in as a plain function so authz stays
 * decoupled from storage. The cascade is read-only: it never relaxes
 * `stream.append` or any write verb.
 */
export type FrickCascadeGrantLookup = (args: {
  tenantId: string;
  granteeUserId: string;
  /** The stream's `streamId` or the projection's `key`. */
  recordId: string;
}) => boolean;

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
  hasUser(userId: string): Promise<boolean>;
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
    hasUser(tenantId: string, userId: string): Promise<boolean>;
  },
  tenantId: string,
): MembershipReader {
  return {
    hasUser: (userId) => store.hasUser(tenantId, userId),
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

const BUILT_IN_FOUNDATION_SEARCH_INDEXES = new Set<string>();
const FOUNDATION_SEARCH_STREAMS_WITH_SOURCE_VISIBILITY = new Set<string>();
const FOUNDATION_SEARCH_OBJECTS_WITH_SOURCE_VISIBILITY = new Set<string>();

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
 *
 * Exception: custom app-source search indexes fail closed until a hook
 * explicitly returns {@link ALLOW} for `search.query` on that index. Deny
 * decisions still win. This keeps the default hook model tightening-only
 * while giving apps a deliberate opt-in for search surfaces the framework
 * cannot prove safe by source visibility alone.
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
      // Base search auth only proves authentication and tenant scope. The
      // route-level assertCanQuerySearch wrapper below adds index-specific
      // defaults: built-in/foundation-backed indexes with source visibility
      // proof are queryable, while custom app-source indexes require an
      // explicit allow from an app policy hook.
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
      void memberships;
      // Custom app objects are app-owned and remain writable by authenticated
      // tenant users unless a policy hook tightens the decision.
      return ALLOW;
    }
    case "stream.read":
    case "stream.append": {
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
  void principal;
  void key;
  void memberships;
  return ALLOW;
}

function decidePresenceAccess(
  principal: Principal,
  name: string | undefined,
  key: string | undefined,
  value: unknown,
  memberships: MembershipReader,
): FrickDecision {
  void principal;
  void name;
  void key;
  void value;
  void memberships;
  return ALLOW;
}

/**
 * Runs registered policy hooks after the framework's default decision. This
 * helper only allows hooks to tighten an already-allowed decision; search's
 * explicit app-index opt-in is handled by `explicitSearchPolicyAllow`.
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
  grantLookup?: FrickGrantLookup,
  cascadeGrantLookup?: FrickCascadeGrantLookup,
): FrickDecision {
  const afterHooks = applyPolicyHooks(decide(input, memberships), input, hooks);
  const afterObjectGrants = relaxWithGrants(afterHooks, input, grantLookup);
  return relaxWithCascadeGrants(afterObjectGrants, input, cascadeGrantLookup);
}

/**
 * Cross-user sharing relaxation. Runs after the baseline policy + app
 * hooks. Only flips a deny to allow; never the other direction.
 *
 * Eligibility: the action is `object.read` or `object.write`, the resource
 * identifies a specific object (kind=object, name + key both present), the
 * deny reason is `notAuthorizedForResource` or `ownerMismatch`, and a
 * registered grant lookup confirms the principal holds a grant whose
 * permission satisfies the action.
 *
 * Skipped when: `tenantMismatch`/`unauthenticated`/`notMember`/`schema*`
 * (out of scope for sharing), when the lookup is not provided (tests, or
 * a host that doesn't ship the sharing tables), or when there's no
 * principal to attribute the grant to.
 */
function relaxWithGrants(
  decision: FrickDecision,
  input: FrickPolicyInput,
  grantLookup: FrickGrantLookup | undefined,
): FrickDecision {
  if (decision.allow || !grantLookup) {
    return decision;
  }
  if (input.action !== "object.read" && input.action !== "object.write") {
    return decision;
  }
  if (
    decision.reason !== "notAuthorizedForResource" &&
    decision.reason !== "ownerMismatch"
  ) {
    return decision;
  }
  const principal = input.principal;
  if (!principal) {
    return decision;
  }
  const { kind, name, key } = input.resource;
  if (kind !== "object" || !name || !key) {
    return decision;
  }
  const required: FrickSharingPermission =
    input.action === "object.write" ? "write" : "read";
  const allowed = grantLookup({
    tenantId: principal.tenantId,
    granteeUserId: principal.userId,
    recordType: name,
    recordId: key,
    required,
  });
  return allowed ? ALLOW : decision;
}

/**
 * Cross-user sharing cascade for derived primitives (FR-70). Runs after the
 * baseline policy, app hooks, and the object-record grant relaxation. Only
 * flips a deny to allow; never the other direction.
 *
 * Eligibility: the action is `stream.read` or `projection.read`, the resource
 * identifies a specific stream/projection *row* (kind + key present), the deny
 * reason is `notAuthorizedForResource` or `ownerMismatch`, and a registered
 * cascade lookup confirms the principal holds an active, read-satisfying grant
 * on an object record whose id equals the row's id.
 *
 * Association rule (documented in docs/threat-model.md): a grant on object
 * record `(recordType, recordId)` authorizes the grantee to READ
 *  - the stream whose `streamId === recordId`, and
 *  - the projection rows whose `key === recordId`,
 * within the same tenant. The match is by record id, because streams and
 * projections are keyed by id, not by object type. When a surface has no
 * resolvable row id (e.g. a projection subscribe without a `key`, which spans
 * the whole projection), the cascade is skipped and the original deny stands —
 * we fail closed rather than over-share.
 *
 * The cascade is strictly read-only: `stream.append` and every write verb are
 * never relaxed here. It is also skipped for `tenantMismatch` /
 * `unauthenticated` / `notMember` / `schema*` (out of scope for sharing),
 * when no cascade lookup is provided, or when there is no principal.
 */
function relaxWithCascadeGrants(
  decision: FrickDecision,
  input: FrickPolicyInput,
  cascadeGrantLookup: FrickCascadeGrantLookup | undefined,
): FrickDecision {
  if (decision.allow || !cascadeGrantLookup) {
    return decision;
  }
  if (input.action !== "stream.read" && input.action !== "projection.read") {
    return decision;
  }
  // Mirror the reason filter used by the object-record grant relaxation
  // (`relaxWithGrants`): only same-tenant ownership/authorization denials are
  // eligible. `tenantMismatch` / `unauthenticated` / `schema*` stay denied.
  if (
    decision.reason !== "notAuthorizedForResource" &&
    decision.reason !== "ownerMismatch" &&
    decision.reason !== "notMember"
  ) {
    return decision;
  }
  const principal = input.principal;
  if (!principal) {
    return decision;
  }
  const { kind, key } = input.resource;
  // The cascade needs a concrete row id to tie back to a granted object.
  // Without one (e.g. a whole-projection subscribe) we cannot prove the
  // association, so we leave the deny in place (fail closed).
  if ((kind !== "stream" && kind !== "projection") || !key) {
    return decision;
  }
  const allowed = cascadeGrantLookup({
    tenantId: principal.tenantId,
    granteeUserId: principal.userId,
    recordId: key,
  });
  return allowed ? ALLOW : decision;
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
  cascadeGrantLookup?: FrickCascadeGrantLookup,
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
      undefined,
      cascadeGrantLookup,
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
    undefined,
    cascadeGrantLookup,
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
  void stream;
  void event;
  void payload;
}

export function assertCanWriteObject(
  principal: Principal,
  objectType: string,
  objectId: string,
  memberships: MembershipReader,
  hooks?: readonly FrickPolicyHook[],
  value?: Record<string, unknown>,
  grantLookup?: FrickGrantLookup,
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
    grantLookup,
  );
  if (!decision.allow) {
    throw new AuthorizationError(decision);
  }
}

/**
 * Object read assertion. Mirrors {@link assertCanWriteObject} but for
 * `object.read`. The framework's default decision for `object.read` is
 * deny (the verb isn't in the `decide()` switch), so callers rely on this
 * helper exclusively when they need to gate an object-by-id read. App
 * policy hooks can flip to allow; grants registered via `grantLookup`
 * relax remaining denies for ownership reasons.
 *
 * Storage-side reads (e.g. tenant-scoped list endpoints) don't go through
 * here — they already inherit tenant isolation at the SQL layer.
 */
export function assertCanReadObject(
  principal: Principal,
  objectType: string,
  objectId: string,
  memberships: MembershipReader,
  hooks?: readonly FrickPolicyHook[],
  grantLookup?: FrickGrantLookup,
): void {
  const decision = decideWithHooks(
    {
      principal,
      action: "object.read",
      resource: { kind: "object", name: objectType, key: objectId, tenantId: principal.tenantId },
    },
    memberships,
    hooks,
    grantLookup,
  );
  if (!decision.allow) {
    throw new AuthorizationError(decision);
  }
}

/**
 * Per-record read visibility for one row delivered over an object SUBSCRIPTION
 * (FR-116). Returns `true` iff this subscriber may see `(objectType, objectId)`
 * in an object snapshot or live delta.
 *
 * It runs the same tightening-only pipeline the rest of object authz uses —
 * baseline -> app policy hooks -> grant relaxation — for the `object.read`
 * action, with the subscriber's principal, the registered policy hooks and the
 * grant lookup. Only the baseline differs from {@link assertCanReadObject}:
 *  - The subscription baseline is tenant-wide ALLOW. This is the historic
 *    behavior of the sync object snapshot/fan-out before per-record authz: a
 *    subscriber that passed {@link assertCanSubscribe} saw every in-tenant row,
 *    so absent any app policy the row set is unchanged.
 *  - A registered hook may TIGHTEN that allow to a deny for a given
 *    principal/record (e.g. a customer portal denying `object.read` for the
 *    customer role), exactly as {@link applyPolicyHooks} does elsewhere.
 *  - A grant then relaxes a remaining deny back to allow for the records the
 *    subscriber holds a grant on, mirroring {@link relaxWithGrants}.
 *
 * `assertCanReadObject` instead starts from deny-by-default because it gates a
 * bare by-id read where the framework cannot assume tenant-wide visibility.
 *
 * Tenant scoping is enforced by the caller before this runs; the `memberships`
 * reader is accepted for signature parity with the other object-authz helpers.
 */
export function canSubscriberReadObjectRecord(
  principal: Principal,
  objectType: string,
  objectId: string,
  memberships: MembershipReader,
  hooks?: readonly FrickPolicyHook[],
  grantLookup?: FrickGrantLookup,
): boolean {
  void memberships;
  const input: FrickPolicyInput = {
    principal,
    action: "object.read",
    resource: { kind: "object", name: objectType, key: objectId, tenantId: principal.tenantId },
  };
  const afterHooks = applyPolicyHooks(ALLOW, input, hooks);
  return relaxWithGrants(afterHooks, input, grantLookup).allow;
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
  index: FrickSearchIndexDefinition,
  memberships: MembershipReader,
  hooks?: readonly FrickPolicyHook[],
): void {
  const input: FrickPolicyInput = {
    principal,
    action: "search.query",
    resource: { kind: "search", name: indexName, tenantId: principal.tenantId },
    context: {
      sourceKind: index.source.kind,
      sourceName: searchIndexSourceName(index),
      defaultTenantAccess: hasDefaultTenantSearchAccess(indexName, index),
    },
  };
  const baseline = decide(input, memberships);
  let decision: FrickDecision;
  if (
    !baseline.allow ||
    principal.scope === "admin" ||
    hasDefaultTenantSearchAccess(indexName, index)
  ) {
    decision = applyPolicyHooks(baseline, input, hooks);
  } else {
    decision = explicitSearchPolicyAllow(input, hooks);
  }
  if (!decision.allow) {
    throw new AuthorizationError(decision);
  }
}

function hasDefaultTenantSearchAccess(
  indexName: string,
  index: FrickSearchIndexDefinition,
): boolean {
  if (BUILT_IN_FOUNDATION_SEARCH_INDEXES.has(indexName)) {
    return true;
  }
  switch (index.source.kind) {
    case "stream":
      return FOUNDATION_SEARCH_STREAMS_WITH_SOURCE_VISIBILITY.has(index.source.type);
    case "object":
      return FOUNDATION_SEARCH_OBJECTS_WITH_SOURCE_VISIBILITY.has(index.source.type);
    case "projection":
      return false;
    default:
      return false;
  }
}

function searchIndexSourceName(index: FrickSearchIndexDefinition): string {
  switch (index.source.kind) {
    case "stream":
    case "object":
      return index.source.type;
    case "projection":
      return index.source.name;
    default:
      return "";
  }
}

function explicitSearchPolicyAllow(
  input: FrickPolicyInput,
  hooks: readonly FrickPolicyHook[] | undefined,
): FrickDecision {
  if (!hooks || hooks.length === 0) {
    return deny(
      "notAuthorizedForResource",
      "Search index requires an explicit app policy allow",
    );
  }
  let allowed = false;
  for (const hook of hooks) {
    const verdict = hook(input);
    if (verdict && !verdict.allow) {
      return verdict;
    }
    if (verdict?.allow) {
      allowed = true;
    }
  }
  return allowed
    ? ALLOW
    : deny(
        "notAuthorizedForResource",
        "Search index requires an explicit app policy allow",
      );
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
  hasUser: () => Promise.resolve(false),
};

function userIdFromReplica(replicaId: string): string {
  return `user-${replicaId}`;
}
