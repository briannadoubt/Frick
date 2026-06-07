/**
 * Declarative RBAC policy-hook builder (FR-133).
 *
 * A synchronous, tightening-only policy hook that evaluates a
 * role × action × resource-type matrix is generic — only the matrix data is
 * app-specific. This builder ships the mechanism so apps declare the matrix
 * and get a {@link FrickPolicyHook} back.
 *
 * The hook can only DENY (policy hooks run after the framework's default
 * decision and may tighten, never grant — see {@link FrickPolicyHook}). It
 * opines ONLY on the (role, action) pairs the matrix governs; everything else
 * returns "no opinion" so the framework default and other hooks still stand.
 *
 * Deriving a role from the principal is app-specific and intentionally NOT
 * provided: pass {@link RbacMatrix.resolveRole}. A production deployment would
 * resolve the role from the user's profile at session-issue time and stamp it
 * on the principal; do not bake a userId-string convention into the framework.
 */
import { type FrickAction, type FrickPolicyHook, type Principal, deny } from "../authz.js";

/**
 * Per-(role, action) resource rule:
 *  - `"all"`  — the role may perform the action on any resource type.
 *  - `"none"` — the role may never perform the action (denied outright).
 *  - `{ allow }` — permitted only for the listed resource types; others denied.
 *  - `{ deny }`  — permitted for everything EXCEPT the listed resource types.
 */
export type RbacResourceRule =
  | "all"
  | "none"
  | { readonly allow: readonly string[] }
  | { readonly deny: readonly string[] };

export interface RbacMatrix {
  /**
   * Derive the acting role from the principal, or `undefined` when no role
   * applies (the hook then offers no opinion). The framework already denies
   * unauthenticated principals before hooks run.
   */
  resolveRole(principal: Principal | undefined): string | undefined;
  /**
   * `role → action → rule`. An action absent from a role's entry is NOT
   * governed for that role — the hook returns no opinion for it. A role absent
   * from the matrix is likewise ungoverned.
   */
  roles: Readonly<Record<string, Partial<Record<FrickAction, RbacResourceRule>>>>;
  /**
   * Optional custom deny message. Defaults to a generic message naming the
   * role, action, and resource.
   */
  denyMessage?(input: { role: string; action: FrickAction; resourceName: string | undefined }): string;
}

/** Returns true when `rule` denies the action for `resourceName`. */
function isDenied(rule: RbacResourceRule, resourceName: string | undefined): boolean {
  if (rule === "all") return false;
  if (rule === "none") return true;
  if ("allow" in rule) {
    // Permitted only for listed types. An action with no resource name can't
    // match a positive allow-list, so it is denied.
    return resourceName === undefined || !rule.allow.includes(resourceName);
  }
  // deny-list: denied only when the resource is explicitly listed.
  return resourceName !== undefined && rule.deny.includes(resourceName);
}

function defaultDenyMessage(role: string, action: FrickAction, resourceName?: string): string {
  return resourceName
    ? `Role "${role}" is not permitted to ${action} ${resourceName} resources.`
    : `Role "${role}" is not permitted to ${action}.`;
}

/**
 * Build a {@link FrickPolicyHook} from a declarative RBAC {@link RbacMatrix}.
 * Register the returned hook via `createFrickServer({ policyHooks: [hook] })`.
 */
export function makeRbacPolicyHook(matrix: RbacMatrix): FrickPolicyHook {
  return (input) => {
    const role = matrix.resolveRole(input.principal);
    if (role === undefined) return null;
    const roleRules = matrix.roles[role];
    if (!roleRules) return null;
    const rule = roleRules[input.action];
    if (rule === undefined) return null; // action not governed for this role
    const resourceName = input.resource.name;
    if (!isDenied(rule, resourceName)) return null;
    const message =
      matrix.denyMessage?.({ role, action: input.action, resourceName }) ??
      defaultDenyMessage(role, input.action, resourceName);
    return deny("notAuthorizedForResource", message);
  };
}
