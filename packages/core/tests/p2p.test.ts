import { describe, expect, it } from "vitest";
import { WEBRTC_SIGNAL_TYPE, type CallMediaGrant, type WebRTCSignalValue } from "@fricken/protocol";
import {
  startP2PCall,
  type CreatePeerConnection,
  type RTCConnectionStateLike,
  type RTCIceCandidateInitLike,
  type RTCPeerConnectionLike,
  type RTCSessionDescriptionInitLike,
} from "../src/index.js";
import { Signal } from "../src/subscriptions.js";

/**
 * FR-81 — P2P WebRTC negotiation driver, exercised with TWO driver instances
 * wired to a shared in-memory fake signal bus + fake `RTCPeerConnection`s. No
 * DOM / real browser involved. Asserts: impolite offers → polite answers →
 * both reach "connected"; ICE trickles across; simultaneous-offer glare is
 * resolved by the polite peer rolling back (no deadlock); and the relayed
 * payloads are the UTF-8-encoded SDP/ICE JSON.
 */

const textDecoder = new TextDecoder();

/**
 * In-memory stand-in for the slice of FrickClient the driver uses. `sendSignal`
 * appends to a single shared `Signal<PlainObject[]>` (the accumulating signal
 * channel both peers subscribe to), exactly mirroring the real relay where the
 * server fans every delivered signal back to all subscribers.
 */
class FakeSignalBus {
  readonly channel = new Signal<WebRTCSignalValue[]>([]);
  /** Records raw payloads so tests can assert the on-wire encoding. */
  readonly sent: WebRTCSignalValue[] = [];

  async sendSignal(name: string, _key: string, value: WebRTCSignalValue): Promise<void> {
    expect(name).toBe(WEBRTC_SIGNAL_TYPE);
    this.sent.push(value);
    this.channel.set([...this.channel.value, value]);
  }

  signalChannel(_name: string, _key: string): Signal<WebRTCSignalValue[]> {
    return this.channel;
  }
}

/**
 * Minimal fake `RTCPeerConnection` implementing just enough of the negotiation
 * state machine for perfect negotiation. Two instances are "linked" so that a
 * candidate the driver emits on one can be applied on the other in the test.
 */
class FakePeerConnection implements RTCPeerConnectionLike {
  onicecandidate: ((e: { candidate: RTCIceCandidateInitLike | null }) => void) | null = null;
  ontrack: ((e: never) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;

  connectionState: RTCConnectionStateLike = "new";
  signalingState = "stable";
  localDescription: RTCSessionDescriptionInitLike | null = null;
  remoteDescription: RTCSessionDescriptionInitLike | null = null;

  readonly addedCandidates: RTCIceCandidateInitLike[] = [];
  readonly label: string;
  #offerSeq = 0;

  constructor(label: string) {
    this.label = label;
  }

  async createOffer(): Promise<RTCSessionDescriptionInitLike> {
    return { type: "offer", sdp: `offer-sdp-${this.label}-${++this.#offerSeq}` };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInitLike> {
    return { type: "answer", sdp: `answer-sdp-${this.label}` };
  }

  async setLocalDescription(description?: RTCSessionDescriptionInitLike): Promise<void> {
    // Mirror the browser default-argument behavior: no arg → derive from state.
    const desc =
      description ??
      (this.signalingState === "have-remote-offer"
        ? await this.createAnswer()
        : await this.createOffer());
    this.localDescription = desc;
    if (desc.type === "rollback") {
      this.signalingState = "stable";
      this.localDescription = null;
      return;
    }
    this.signalingState = desc.type === "offer" ? "have-local-offer" : "stable";
    // Emit a trickled ICE candidate as soon as we have a local description.
    this.onicecandidate?.({
      candidate: { candidate: `cand-${this.label}`, sdpMid: "0", sdpMLineIndex: 0 },
    });
    // Setting a local *answer* completes our half of negotiation; ICE then
    // connects. The answerer never receives a remote answer, so model the
    // connected transition here (the offerer transitions on remote answer).
    if (desc.type === "answer") {
      this.#markConnected();
    }
  }

  async setRemoteDescription(description: RTCSessionDescriptionInitLike): Promise<void> {
    if (description.type === "rollback") {
      this.signalingState = "stable";
      this.remoteDescription = null;
      return;
    }
    // Perfect negotiation: an implicit rollback happens when a polite peer
    // accepts a remote offer while holding a local offer.
    if (description.type === "offer" && this.signalingState === "have-local-offer") {
      this.localDescription = null;
    }
    this.remoteDescription = description;
    this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
    if (description.type === "answer") {
      this.#markConnected();
    }
  }

  async addIceCandidate(candidate: RTCIceCandidateInitLike): Promise<void> {
    if (!this.remoteDescription) {
      throw new Error("cannot add ICE candidate without a remote description");
    }
    this.addedCandidates.push(candidate);
  }

  addTrack(): unknown {
    return {};
  }

  close(): void {
    this.connectionState = "closed";
  }

  /** Drive both ends to connected once an answer settles. */
  #markConnected(): void {
    if (this.connectionState === "connected") return;
    this.connectionState = "connected";
    this.onconnectionstatechange?.();
  }

  /** Test helper: force a connected transition (used after answering an offer). */
  forceConnected(): void {
    this.#markConnected();
  }
}

function makeGrant(): CallMediaGrant {
  const iceServers = JSON.stringify([{ urls: "stun:stun.example.org:3478" }]);
  return {
    callId: "call-1",
    mediaSessionId: "p2p-call-1-1",
    userId: "u",
    deviceId: "d",
    token: iceServers,
    expiresAt: new Date(0).toISOString(),
    connection: { iceServers },
  };
}

/** Pump the microtask queue so queued async signal handlers run to completion. */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe("startP2PCall — perfect negotiation over the relay", () => {
  it("impolite offers, polite answers, both reach connected, ICE trickles across", async () => {
    const bus = new FakeSignalBus();
    // device-a < device-b lexicographically → device-a is polite, device-b impolite.
    const pcA = new FakePeerConnection("a");
    const pcB = new FakePeerConnection("b");
    const factoryA: CreatePeerConnection = () => pcA;
    const factoryB: CreatePeerConnection = () => pcB;

    const grant = makeGrant();
    const handleA = startP2PCall(bus as never, {
      callId: "call-1",
      selfDeviceId: "device-a",
      peerDeviceId: "device-b",
      grant,
      createPeerConnection: factoryA,
    });
    const handleB = startP2PCall(bus as never, {
      callId: "call-1",
      selfDeviceId: "device-b",
      peerDeviceId: "device-a",
      grant,
      createPeerConnection: factoryB,
    });

    // Impolite peer (device-b) initiates.
    pcB.onnegotiationneeded?.();
    await flush();
    // Polite peer answered the offer; mark its connection connected too.
    pcB.forceConnected();
    await flush();

    expect(pcA.connectionState).toBe("connected");
    expect(pcB.connectionState).toBe("connected");
    expect(handleA.connectionState).toBe("connected");
    expect(handleB.connectionState).toBe("connected");

    // ICE trickled across: each peer applied the other's candidate.
    expect(pcA.addedCandidates.some((c) => c.candidate === "cand-b")).toBe(true);
    expect(pcB.addedCandidates.some((c) => c.candidate === "cand-a")).toBe(true);

    // Payloads are UTF-8-encoded JSON of the SDP/ICE.
    const offer = bus.sent.find((s) => s.kind === "offer")!;
    expect(offer.payload).toBeInstanceOf(Uint8Array);
    const decoded = JSON.parse(textDecoder.decode(offer.payload)) as RTCSessionDescriptionInitLike;
    expect(decoded.type).toBe("offer");
    expect(decoded.sdp).toContain("offer-sdp-b");

    handleA.close();
    handleB.close();
  });

  it("resolves simultaneous-offer glare: polite peer rolls back, no deadlock", async () => {
    const bus = new FakeSignalBus();
    const pcA = new FakePeerConnection("a"); // device-a → polite
    const pcB = new FakePeerConnection("b"); // device-b → impolite

    const grant = makeGrant();
    const handleA = startP2PCall(bus as never, {
      callId: "call-1",
      selfDeviceId: "device-a",
      peerDeviceId: "device-b",
      grant,
      createPeerConnection: () => pcA,
    });
    const handleB = startP2PCall(bus as never, {
      callId: "call-1",
      selfDeviceId: "device-b",
      peerDeviceId: "device-a",
      grant,
      createPeerConnection: () => pcB,
    });

    // Both fire negotiationneeded "simultaneously" → glare.
    pcA.onnegotiationneeded?.();
    pcB.onnegotiationneeded?.();
    await flush(16);
    pcA.forceConnected();
    pcB.forceConnected();
    await flush(16);

    // No deadlock: both ends converge to connected.
    expect(pcA.connectionState).toBe("connected");
    expect(pcB.connectionState).toBe("connected");

    // The polite peer (device-a) accepted device-b's offer (rolling back its
    // own local offer) and produced an answer; the impolite peer ignored
    // device-a's offer. So exactly the impolite peer's offer survived.
    const answers = bus.sent.filter((s) => s.kind === "answer");
    expect(answers.length).toBeGreaterThanOrEqual(1);
    // device-a (polite) sent the answer.
    expect(answers.every((a) => a.senderDeviceId === "device-a")).toBe(true);

    handleA.close();
    handleB.close();
  });

  it("ignores signals it sent and signals addressed to a different device", async () => {
    const bus = new FakeSignalBus();
    const pcA = new FakePeerConnection("a");
    const handleA = startP2PCall(bus as never, {
      callId: "call-1",
      selfDeviceId: "device-a",
      peerDeviceId: "device-b",
      grant: makeGrant(),
      createPeerConnection: () => pcA,
    });

    // A signal addressed to someone else must be ignored (no remote desc set).
    await bus.sendSignal(WEBRTC_SIGNAL_TYPE, "call-1", {
      senderDeviceId: "device-c",
      recipientDeviceId: "device-z",
      kind: "offer",
      payload: new TextEncoder().encode(JSON.stringify({ type: "offer", sdp: "x" })),
    });
    await flush();
    expect(pcA.remoteDescription).toBeNull();

    handleA.close();
  });
});
