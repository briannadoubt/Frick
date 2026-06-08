/**
 * FR-81 — self-built one-to-one P2P WebRTC negotiation driver.
 *
 * Drives an `RTCPeerConnection` between exactly two peers using the WHATWG
 * **perfect negotiation** pattern, exchanging SDP and ICE candidates over the
 * EXISTING Frick `WebRTCSignal` relay (`client.sendSignal` /
 * `client.signalChannel`). No media server is involved — once negotiation
 * completes media flows directly peer↔peer over WebRTC/SRTP.
 *
 * Perfect negotiation needs one peer to be "polite" (rolls back on offer glare)
 * and one "impolite" (ignores the incoming offer and keeps its own). We pick
 * deterministically by comparing the two device ids: the lexicographically
 * smaller device id is the **polite** peer. Because both sides see the same two
 * ids they always agree on roles with zero coordination, which is what prevents
 * an offer/offer deadlock.
 *
 * The browser `RTCPeerConnection` is abstracted behind {@link RTCPeerConnectionLike}
 * and an injectable {@link CreatePeerConnection} factory so the full negotiation
 * is unit-testable against a fake peer connection + a fake signal bus — no DOM.
 */

import type { WebRTCSignalValue } from "@fricken/protocol";
import { WEBRTC_SIGNAL_TYPE } from "@fricken/protocol";
import type { CallMediaGrant, PlainObject } from "@fricken/protocol";
import type { FrickClient } from "./runtime.js";

/**
 * The minimal slice of the browser `RTCPeerConnection` the driver depends on.
 * Defining it explicitly (rather than reusing the DOM lib type) lets tests inject
 * a fake with no `globalThis.RTCPeerConnection`.
 */
export interface RTCPeerConnectionLike {
  createOffer(): Promise<RTCSessionDescriptionInitLike>;
  createAnswer(): Promise<RTCSessionDescriptionInitLike>;
  setLocalDescription(description?: RTCSessionDescriptionInitLike): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInitLike): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInitLike): Promise<void>;
  addTrack(track: MediaStreamTrackLike, ...streams: MediaStreamLike[]): unknown;
  close(): void;
  /** Set by the driver; fires for each locally-gathered ICE candidate. */
  onicecandidate: ((event: { candidate: RTCIceCandidateInitLike | null }) => void) | null;
  /** Set by the driver; fires when a remote track arrives. */
  ontrack: ((event: RTCTrackEventLike) => void) | null;
  /** Set by the driver; fires when `connectionState` changes. */
  onconnectionstatechange: (() => void) | null;
  /** Set by the driver; fires when the browser wants a (re)negotiation. */
  onnegotiationneeded: (() => void) | null;
  readonly connectionState: RTCConnectionStateLike;
  /** "stable" | "have-local-offer" | "have-remote-offer" | ... */
  readonly signalingState: string;
}

export type RTCConnectionStateLike =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export interface RTCSessionDescriptionInitLike {
  readonly type: "offer" | "answer" | "pranswer" | "rollback";
  readonly sdp?: string;
}

export interface RTCIceCandidateInitLike {
  readonly candidate?: string;
  readonly sdpMid?: string | null;
  readonly sdpMLineIndex?: number | null;
  readonly usernameFragment?: string | null;
}

export interface MediaStreamTrackLike {
  readonly kind: string;
  readonly id: string;
}

export interface MediaStreamLike {
  readonly id: string;
  getTracks(): readonly MediaStreamTrackLike[];
}

export interface RTCTrackEventLike {
  readonly track: MediaStreamTrackLike;
  readonly streams: readonly MediaStreamLike[];
}

/** Factory the driver calls to obtain a peer connection. Defaults to the DOM ctor. */
export type CreatePeerConnection = (config: RTCConfigurationLike) => RTCPeerConnectionLike;

/** Minimal `RTCConfiguration` shape (just the ICE servers the driver forwards). */
export interface RTCConfigurationLike {
  readonly iceServers?: readonly {
    readonly urls: string | readonly string[];
    readonly username?: string;
    readonly credential?: string;
  }[];
}

export interface StartP2PCallOptions {
  readonly callId: string;
  readonly selfDeviceId: string;
  readonly peerDeviceId: string;
  /**
   * The media join grant from `joinCall`; its `connection.iceServers` is the
   * JSON-serialized `RTCIceServer[]` the {@link P2PWebRTCAdapter} minted.
   */
  readonly grant: CallMediaGrant;
  /** Local media to attach (mic/camera). Optional — a recvonly peer omits it. */
  readonly localStream?: MediaStreamLike;
  /** Override the peer-connection factory (tests inject a fake). */
  readonly createPeerConnection?: CreatePeerConnection;
}

/**
 * Live handle to a P2P call. Exposes the underlying connection, the remote
 * media as it arrives, the current connection state, and `close()` to tear
 * everything down (closes the PC and unsubscribes from the relay).
 */
export interface P2PCallHandle {
  /** The live peer connection (the real `RTCPeerConnection` in production). */
  readonly connection: RTCPeerConnectionLike;
  /** Latest WebRTC connection state, mirrored off the peer connection. */
  readonly connectionState: RTCConnectionStateLike;
  /** The remote stream once a track has arrived, else `undefined`. */
  readonly remoteStream: MediaStreamLike | undefined;
  /** Subscribe to connection-state transitions. Returns an unsubscribe. */
  onStateChange(listener: (state: RTCConnectionStateLike) => void): () => void;
  /** Subscribe to the remote stream arriving. Returns an unsubscribe. */
  onRemoteStream(listener: (stream: MediaStreamLike) => void): () => void;
  /** Close the peer connection and detach from the signal relay. */
  close(): void;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function defaultCreatePeerConnection(config: RTCConfigurationLike): RTCPeerConnectionLike {
  const Ctor = (globalThis as unknown as {
    RTCPeerConnection?: new (c: RTCConfigurationLike) => RTCPeerConnectionLike;
  }).RTCPeerConnection;
  if (!Ctor) {
    throw new Error("No global RTCPeerConnection available; pass createPeerConnection");
  }
  return new Ctor(config);
}

/** Parse the grant's JSON-serialized ICE servers into an RTCConfiguration. */
function parseIceServers(grant: CallMediaGrant): RTCConfigurationLike {
  const raw = grant.connection?.["iceServers"] ?? grant.token;
  if (!raw) {
    return { iceServers: [] };
  }
  try {
    const parsed = JSON.parse(raw) as RTCConfigurationLike["iceServers"];
    return { iceServers: Array.isArray(parsed) ? parsed : [] };
  } catch {
    return { iceServers: [] };
  }
}

/** Encode an SDP/ICE JSON object as the UTF-8 `payload` bytes carried on the relay. */
function encodePayload(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

function decodePayload(payload: Uint8Array): unknown {
  // The relay may round-trip the bytes as a plain object/array (e.g. through a
  // JSON-encoding transport in tests); normalize to a Uint8Array first.
  const bytes =
    payload instanceof Uint8Array
      ? payload
      : new Uint8Array(Object.values(payload as Record<string, number>));
  return JSON.parse(textDecoder.decode(bytes));
}

/**
 * Start (or answer) a one-to-one P2P WebRTC call. Both peers call this with the
 * same `callId` and each other's device ids; perfect negotiation drives them to
 * a connected state regardless of who calls first (and resolves offer glare).
 */
export function startP2PCall(client: FrickClient, options: StartP2PCallOptions): P2PCallHandle {
  const { callId, selfDeviceId, peerDeviceId, grant, localStream } = options;
  const createPeerConnection = options.createPeerConnection ?? defaultCreatePeerConnection;

  // Deterministic role assignment: the smaller device id is polite. Both peers
  // compute the same answer, so roles never conflict.
  const polite = selfDeviceId < peerDeviceId;

  const config = parseIceServers(grant);
  const pc = createPeerConnection(config);

  let makingOffer = false;
  let ignoreOffer = false;
  let isSettingRemoteAnswerPending = false;
  let closed = false;

  let remoteStream: MediaStreamLike | undefined;
  let hasRemoteDescription = false;
  /** ICE candidates that arrived before a remote description; flushed after. */
  const pendingRemoteCandidates: RTCIceCandidateInitLike[] = [];
  const stateListeners = new Set<(state: RTCConnectionStateLike) => void>();
  const streamListeners = new Set<(stream: MediaStreamLike) => void>();

  // Attach local media before wiring negotiation so the first offer carries it.
  if (localStream) {
    for (const track of localStream.getTracks()) {
      pc.addTrack(track, localStream);
    }
  }

  function send(kind: WebRTCSignalValue["kind"], payload: unknown): void {
    const value: WebRTCSignalValue = {
      senderDeviceId: selfDeviceId,
      recipientDeviceId: peerDeviceId,
      kind,
      payload: encodePayload(payload),
    };
    void client.sendSignal(WEBRTC_SIGNAL_TYPE, callId, value as unknown as PlainObject);
  }

  pc.onnegotiationneeded = () => {
    void (async () => {
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        send("offer", describeLocal(pc));
      } catch {
        // Swallow — a failed offer surfaces via connectionState.
      } finally {
        makingOffer = false;
      }
    })();
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      send("ice", candidate);
    }
  };

  pc.ontrack = (event) => {
    const stream = event.streams[0];
    if (stream) {
      remoteStream = stream;
      for (const listener of streamListeners) {
        listener(stream);
      }
    }
  };

  pc.onconnectionstatechange = () => {
    for (const listener of stateListeners) {
      listener(pc.connectionState);
    }
  };

  const channel = client.signalChannel(WEBRTC_SIGNAL_TYPE, callId);
  let processed = 0;

  async function handleSignal(value: WebRTCSignalValue): Promise<void> {
    if (closed) return;
    // Ignore our own echoes and messages addressed to a different device.
    if (value.senderDeviceId === selfDeviceId) return;
    if (value.recipientDeviceId && value.recipientDeviceId !== selfDeviceId) return;
    if (value.senderDeviceId !== peerDeviceId) return;

    const decoded = decodePayload(value.payload);

    if (value.kind === "offer" || value.kind === "answer" || value.kind === "renegotiate") {
      const description = decoded as RTCSessionDescriptionInitLike;
      // Perfect-negotiation glare handling: an impolite peer that is mid-offer
      // (or not in a stable signaling state) ignores an incoming offer.
      const readyForOffer =
        !makingOffer && (pc.signalingState === "stable" || isSettingRemoteAnswerPending);
      const offerCollision = description.type === "offer" && !readyForOffer;
      ignoreOffer = !polite && offerCollision;
      if (ignoreOffer) return;

      isSettingRemoteAnswerPending = description.type === "answer";
      await pc.setRemoteDescription(description);
      isSettingRemoteAnswerPending = false;
      hasRemoteDescription = true;
      // Apply any ICE candidates that raced ahead of the remote description.
      const buffered = pendingRemoteCandidates.splice(0);
      for (const candidate of buffered) {
        try {
          await pc.addIceCandidate(candidate);
        } catch {
          // Stale candidate after a rollback — safe to drop.
        }
      }
      if (description.type === "offer") {
        await pc.setLocalDescription();
        send("answer", describeLocal(pc));
      }
      return;
    }

    if (value.kind === "ice") {
      const candidate = decoded as RTCIceCandidateInitLike;
      // Buffer candidates that arrive before we've applied a remote description;
      // the browser would otherwise reject them. Flushed in the SDP branch above.
      if (!hasRemoteDescription) {
        pendingRemoteCandidates.push(candidate);
        return;
      }
      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        // A failed candidate after we chose to ignore an offer is expected.
        if (!ignoreOffer) throw error;
      }
    }
  }

  function drain(entries: readonly PlainObject[]): void {
    for (let i = processed; i < entries.length; i += 1) {
      const value = entries[i] as unknown as WebRTCSignalValue;
      void handleSignal(value);
    }
    processed = entries.length;
  }

  const unsubscribe = channel.subscribe((entries) => drain(entries));

  const handle: P2PCallHandle = {
    connection: pc,
    get connectionState() {
      return pc.connectionState;
    },
    get remoteStream() {
      return remoteStream;
    },
    onStateChange(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onRemoteStream(listener) {
      streamListeners.add(listener);
      return () => streamListeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      stateListeners.clear();
      streamListeners.clear();
      pc.close();
    },
  };

  return handle;
}

/**
 * Read the local description off the peer connection for sending. We re-read it
 * via a tiny accessor so fakes that don't expose `localDescription` can still
 * supply it through `setLocalDescription`'s recorded value.
 */
function describeLocal(pc: RTCPeerConnectionLike): RTCSessionDescriptionInitLike {
  const ld = (pc as { localDescription?: RTCSessionDescriptionInitLike | null }).localDescription;
  if (ld) return { type: ld.type, ...(ld.sdp !== undefined ? { sdp: ld.sdp } : {}) };
  // Fallback used only by minimal fakes: assume offer/answer mirrors signalingState.
  const type = pc.signalingState === "have-local-offer" ? "offer" : "answer";
  return { type };
}
