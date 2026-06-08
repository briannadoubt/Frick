/**
 * FR-83 — Media placement seam.
 *
 * Resolves, for a given `callId`, *which node* homes that call's SFU router and
 * the **reachable media address** clients should connect their WebRTC transports
 * to. This is the single point of indirection that lets the SFU adapter stay
 * single-box today and grow into a multi-node deployment tomorrow without the
 * adapter (or the control plane) changing shape.
 *
 * For FR-83 the only implementation is {@link LocalMediaPlacement} — "always
 * this node". It returns a fixed home node id plus the operator-configured
 * announced media IP (the public/LAN address mediasoup advertises in its ICE
 * candidates).
 *
 * **FR-154** (a separate ticket) adds the bus-coordinated, multi-node
 * implementation: a registry where the *first* node to allocate a call's router
 * becomes its home, that mapping is published on the sync bus, and peers resolve
 * `placeFor(callId)` to the home node's announced address so every participant's
 * transports land on the one router that actually owns the call's media. The
 * interface here is intentionally the minimal surface FR-154 needs.
 */

/** Where a call's media (its SFU router) lives, and how to reach it. */
export interface MediaPlacement {
  /**
   * Resolve the home node + reachable media address for `callId`. Idempotent:
   * repeated calls for the same live call resolve to the same placement.
   */
  placeFor(callId: string): Promise<MediaHome>;
}

/** The node that homes a call's router and the address clients connect to. */
export interface MediaHome {
  /** Stable id of the node hosting the router (this node, for single-box). */
  readonly nodeId: string;
  /**
   * Announced media address mediasoup advertises in ICE candidates — the
   * public or LAN IP/hostname participants route their WebRTC transports to.
   */
  readonly announcedIp: string;
}

export interface LocalMediaPlacementOptions {
  /**
   * Stable id for this node. Defaults to `"local"`. (FR-154 derives this from
   * the bus node identity.)
   */
  readonly nodeId?: string;
  /**
   * The announced media IP/hostname this single box advertises in ICE
   * candidates (e.g. `"127.0.0.1"` for local dev, the box's public IP in prod).
   */
  readonly announcedIp: string;
}

/**
 * Single-box placement: every call is homed on *this* node and reachable at the
 * one configured announced IP. The multi-node, bus-coordinated registry is
 * FR-154 — this impl deliberately does no coordination.
 */
export class LocalMediaPlacement implements MediaPlacement {
  readonly #nodeId: string;
  readonly #announcedIp: string;

  constructor(options: LocalMediaPlacementOptions) {
    this.#nodeId = options.nodeId ?? "local";
    this.#announcedIp = options.announcedIp;
  }

  async placeFor(_callId: string): Promise<MediaHome> {
    void _callId;
    return { nodeId: this.#nodeId, announcedIp: this.#announcedIp };
  }
}
