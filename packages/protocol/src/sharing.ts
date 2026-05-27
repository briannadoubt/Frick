/**
 * Cross-user sharing primitives. These are framework-level concepts (not
 * user-defined schema objects): the server stores them in dedicated tables
 * and the protocol surfaces dedicated HTTP routes for create/accept/list/
 * revoke. Apps that need richer behaviour (e.g. cascading a grant across a
 * record's children) implement it on top of these primitives.
 *
 * Two-phase model, deliberately separated so a recipient never sees the
 * owner's tenant or user id until they redeem:
 *
 *   1. Invitation — transient, single-use token issued by an owner. Carries
 *      the recordType/recordId and the permission to grant. Expires after
 *      `expiresAt`; gets stamped `redeemedAt` + `redeemedByUserId` on
 *      successful accept. The opaque `token` is what the owner ships to the
 *      recipient out-of-band (link, message, whatever).
 *
 *   2. Grant — durable record that "user G has permission P on record R
 *      until revoked." Created by `acceptInvitation`. Owners can list and
 *      revoke; revocation sets `revokedAt` and the framework's authz
 *      decision flow stops honouring it on subsequent reads/writes.
 */
export type FrickSharingPermission = "read" | "write";


export interface FrickInvitation {
  /** Server-issued opaque id. */
  id: string;
  /** Tenant the invitation (and its eventual grant) live in. */
  tenantId: string;
  /** User who issued the invitation. Must be authenticated as this user
   * when creating; appears here so list-side flows can surface "from". */
  ownerUserId: string;
  /** The record's framework object type and id. */
  recordType: string;
  recordId: string;
  /** Permission to be granted on accept. */
  permission: FrickSharingPermission;
  /** Opaque base64url token the recipient redeems via `/share/accept`.
   * Single-use — the server marks `redeemedAt` on first successful accept. */
  token: string;
  /** RFC 3339 timestamps. */
  createdAt: string;
  expiresAt: string;
  redeemedAt?: string;
  redeemedByUserId?: string;
}


export interface FrickGrant {
  id: string;
  tenantId: string;
  /** Owner who issued the underlying invitation. Stable even after revoke. */
  ownerUserId: string;
  recordType: string;
  recordId: string;
  /** User who redeemed the invitation. */
  granteeUserId: string;
  permission: FrickSharingPermission;
  createdAt: string;
  /** Set by the owner via `DELETE /share/grants/:id`. When present, the
   * framework's authz decision flow stops honouring the grant. */
  revokedAt?: string;
}


/** Wire shapes for the sharing HTTP routes. The server reads/writes these
 * verbatim; the Swift/Kotlin SDKs marshal the same field names. */
export interface CreateInvitationRequest {
  recordType: string;
  recordId: string;
  permission: FrickSharingPermission;
  /** Optional. Seconds from now; clamped server-side to a sane maximum.
   * When omitted, the server applies its default (14 days). */
  expiresInSeconds?: number;
}


export interface CreateInvitationResponse {
  invitation: FrickInvitation;
}


export interface AcceptInvitationRequest {
  token: string;
}


export interface AcceptInvitationResponse {
  grant: FrickGrant;
}


export interface ListGrantsRequest {
  /** Optional filters. When both are omitted, returns every active grant
   * the principal owns OR is the grantee of within their tenant. */
  recordType?: string;
  recordId?: string;
  /** When true, include revoked grants. Defaults to false. */
  includeRevoked?: boolean;
}


export interface ListGrantsResponse {
  grants: FrickGrant[];
}


export interface RevokeGrantRequest {
  grantId: string;
}


export interface RevokeGrantResponse {
  grant: FrickGrant;
}


/** Default invitation lifetime when the client doesn't supply one. */
export const DEFAULT_FRICK_INVITATION_TTL_SECONDS = 14 * 24 * 60 * 60;

/** Server-side ceiling on invitation lifetime. Anything larger is clamped
 * down to this. Keeps a misconfigured client from issuing year-long tokens. */
export const MAX_FRICK_INVITATION_TTL_SECONDS = 90 * 24 * 60 * 60;


/** True iff `permission` is at least as strong as `required` for the
 * framework's `object.read` / `object.write` evaluation. Reads accept either
 * permission; writes require `"write"`. */
export function frickSharingPermissionSatisfies(
  permission: FrickSharingPermission,
  required: FrickSharingPermission,
): boolean {
  if (required === "read") {
    return permission === "read" || permission === "write";
  }
  return permission === "write";
}
