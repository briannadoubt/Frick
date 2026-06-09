import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FrickStore } from "../src/store.js";
import {
  CallAuthzError,
  CallControlPlane,
  CallMediaUnsupportedError,
  CallStateError,
  DEFAULT_SFU_MEDIA_CODECS,
  FakeMediaPlaneAdapter,
  FakeSfuBackend,
  SfuMediaPlaneAdapter,
  buildCallSchema,
  callActor,
  type CallActor,
  type SfuTransportParams,
} from "../src/calls/index.js";

// ---------------------------------------------------------------------------
// FR-78 — FakeMediaPlaneAdapter (deterministic, no networking)
// ---------------------------------------------------------------------------

describe("FR-78 — FakeMediaPlaneAdapter", () => {
  it("describes an SFU by default and a 2-party P2P when asked", () => {
    expect(new FakeMediaPlaneAdapter().describe()).toEqual({
      transport: "sfu",
      supportsRegionHint: true,
    });
    expect(new FakeMediaPlaneAdapter({ transport: "p2p" }).describe()).toEqual({
      transport: "p2p",
      maxParticipants: 2,
      supportsRegionHint: false,
    });
  });

  it("allocates a deterministic session and is idempotent per call id", async () => {
    const media = new FakeMediaPlaneAdapter({ now: () => 1_000 });
    const first = await media.allocateSession("call-1", { regionHint: "us-east" });
    expect(first.mediaSessionId).toBe("fake-room-call-1-1");
    expect(first.transport).toBe("sfu");
    expect(first.region).toBe("us-east");
    expect(media.hasSession("call-1")).toBe(true);

    // Second allocate for the same live call returns the same room.
    const again = await media.allocateSession("call-1");
    expect(again.mediaSessionId).toBe("fake-room-call-1-1");

    // A different call gets the next ordinal.
    const second = await media.allocateSession("call-2");
    expect(second.mediaSessionId).toBe("fake-room-call-2-2");
  });

  it("ignores region hints for P2P (unsupported)", async () => {
    const media = new FakeMediaPlaneAdapter({ transport: "p2p" });
    const session = await media.allocateSession("c", { regionHint: "eu" });
    expect(session.region).toBeUndefined();
  });

  it("issues deterministic, per-participant, monotonic join tokens", async () => {
    const media = new FakeMediaPlaneAdapter({ now: () => 0, defaultTokenTtlMs: 60_000 });
    await media.allocateSession("call-1");
    const a1 = await media.issueJoinToken("call-1", { userId: "u1", deviceId: "d1" });
    expect(a1.token).toBe("fake-token.fake-room-call-1-1.u1.d1.1");
    expect(a1.expiresAt).toBe(new Date(60_000).toISOString());

    // Re-issuing for the same participant increments the ordinal.
    const a2 = await media.issueJoinToken("call-1", { userId: "u1", deviceId: "d1" });
    expect(a2.token).toBe("fake-token.fake-room-call-1-1.u1.d1.2");

    // A different participant starts at 1.
    const b1 = await media.issueJoinToken("call-1", { userId: "u2", deviceId: "d9" });
    expect(b1.token).toBe("fake-token.fake-room-call-1-1.u2.d9.1");
  });

  it("rejects a join token when no session is allocated", async () => {
    const media = new FakeMediaPlaneAdapter();
    await expect(
      media.issueJoinToken("missing", { userId: "u", deviceId: "d" }),
    ).rejects.toThrow(/no media session allocated/);
  });

  it("releases sessions idempotently", async () => {
    const media = new FakeMediaPlaneAdapter();
    await media.allocateSession("call-1");
    expect(media.hasSession("call-1")).toBe(true);
    await media.releaseSession("call-1");
    expect(media.hasSession("call-1")).toBe(false);
    // Releasing again / an unknown call is a no-op.
    await expect(media.releaseSession("call-1")).resolves.toBeUndefined();
    await expect(media.releaseSession("never")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FR-79 — Call control-plane state machine
// ---------------------------------------------------------------------------

describe("FR-79 — CallControlPlane", () => {
  let store: FrickStore;
  let media: FakeMediaPlaneAdapter;
  let plane: CallControlPlane;
  let idCounter: number;

  const alice: CallActor = callActor("alice", "alice-web");
  const bob: CallActor = callActor("bob", "bob-phone");
  const carol: CallActor = callActor("carol", "carol-web");

  beforeEach(() => {
    store = new FrickStore({ path: ":memory:", schema: buildCallSchema() });
    media = new FakeMediaPlaneAdapter({ now: () => 1_000 });
    idCounter = 0;
    plane = new CallControlPlane({
      store,
      mediaPlane: media,
      generateId: () => `call-${++idCounter}`,
      now: () => new Date(1_000),
    });
  });

  afterEach(() => {
    store.close();
  });

  async function callEventNames(callId: string): Promise<string[]> {
    const events = await store.readEvents(alice.tenantId, "CallEventStream", callId, 0);
    return events.map((e) => e.event);
  }

  it("creates a call: persists room + invites, allocates media, emits events", async () => {
    const result = await plane.createCall(alice, {
      conversationId: "conv-1",
      inviteeUserIds: ["bob", "carol"],
      kind: "video",
    });

    expect(result.room.id).toBe("call-1");
    expect(result.room.state).toBe("ringing");
    expect(result.room.createdBy).toBe("alice");
    expect(result.room.mediaSessionId).toBe("fake-room-call-1-1");
    expect(media.hasSession("call-1")).toBe(true);
    expect(result.invites.map((i) => i.inviteeUserId).sort()).toEqual(["bob", "carol"]);
    expect(result.invites.every((i) => i.status === "ringing")).toBe(true);

    // Durable room is readable back.
    const room = await plane.getRoom(alice.tenantId, "call-1");
    expect(room?.state).toBe("ringing");

    // Events: one CallCreated + one CallInviteSent per invitee.
    expect(await callEventNames("call-1")).toEqual([
      "CallCreated",
      "CallInviteSent",
      "CallInviteSent",
    ]);
  });

  it("drops the creator from the invitee set and de-dupes", async () => {
    const result = await plane.createCall(alice, {
      conversationId: "conv-1",
      inviteeUserIds: ["alice", "bob", "bob"],
    });
    expect(result.invites.map((i) => i.inviteeUserId)).toEqual(["bob"]);
  });

  it("rejects a call with no real invitees", async () => {
    await expect(
      plane.createCall(alice, { conversationId: "conv-1", inviteeUserIds: ["alice"] }),
    ).rejects.toMatchObject({ name: "CallStateError", reason: "noInvitees" });
  });

  it("lets an invitee join: activates room, issues a media token, emits join", async () => {
    await plane.createCall(alice, { conversationId: "conv-1", inviteeUserIds: ["bob"] });
    const joined = await plane.joinCall(bob, "call-1");

    expect(joined.room.state).toBe("active");
    expect(joined.room.startedAt).toBe(new Date(1_000).toISOString());
    expect(joined.participant.state).toBe("joined");
    expect(joined.mediaGrant.token).toBe("fake-token.fake-room-call-1-1.bob.bob-phone.1");

    expect(await callEventNames("call-1")).toEqual([
      "CallCreated",
      "CallInviteSent",
      "CallInviteAccepted",
      "CallParticipantJoined",
    ]);

    const invites = await plane.listInvites(alice.tenantId, "call-1");
    expect(invites[0]?.status).toBe("accepted");
  });

  it("rejects join from a user who was not invited", async () => {
    await plane.createCall(alice, { conversationId: "conv-1", inviteeUserIds: ["bob"] });
    await expect(plane.joinCall(carol, "call-1")).rejects.toMatchObject({
      name: "CallAuthzError",
      reason: "notInvitee",
    });
  });

  it("rejects join on an ended call", async () => {
    await plane.createCall(alice, { conversationId: "conv-1", inviteeUserIds: ["bob"] });
    await plane.endCall(alice, "call-1");
    await expect(plane.joinCall(bob, "call-1")).rejects.toMatchObject({
      name: "CallStateError",
      reason: "callEnded",
    });
  });

  it("rejects join on an unknown call", async () => {
    await expect(plane.joinCall(bob, "nope")).rejects.toMatchObject({
      name: "CallStateError",
      reason: "callNotFound",
    });
  });

  it("only lets a participant change their own media state", async () => {
    await plane.createCall(alice, { conversationId: "conv-1", inviteeUserIds: ["bob"] });
    await plane.joinCall(bob, "call-1");

    const updated = await plane.setMediaState(bob, "call-1", {
      micEnabled: false,
      cameraEnabled: true,
    });
    expect(updated.micEnabled).toBe(false);
    expect(updated.cameraEnabled).toBe(true);
    expect(await callEventNames("call-1")).toContain("CallParticipantMediaChanged");

    // A non-participant cannot change media state.
    await expect(
      plane.setMediaState(carol, "call-1", { micEnabled: false }),
    ).rejects.toMatchObject({ name: "CallStateError", reason: "notParticipant" });
  });

  it("handles leave and auto-ends when the last participant leaves", async () => {
    await plane.createCall(alice, { conversationId: "conv-1", inviteeUserIds: ["bob"] });
    await plane.joinCall(bob, "call-1");
    expect(media.hasSession("call-1")).toBe(true);

    const room = await plane.leaveCall(bob, "call-1");
    expect(room.state).toBe("ended");
    // Auto-end released the media session.
    expect(media.hasSession("call-1")).toBe(false);

    expect(await callEventNames("call-1")).toEqual([
      "CallCreated",
      "CallInviteSent",
      "CallInviteAccepted",
      "CallParticipantJoined",
      "CallParticipantLeft",
      "CallEnded",
    ]);
  });

  it("does not auto-end while another participant remains", async () => {
    await plane.createCall(alice, {
      conversationId: "conv-1",
      inviteeUserIds: ["bob", "carol"],
    });
    await plane.joinCall(bob, "call-1");
    await plane.joinCall(carol, "call-1");

    const afterBobLeaves = await plane.leaveCall(bob, "call-1");
    expect(afterBobLeaves.state).toBe("active");
    expect(media.hasSession("call-1")).toBe(true);

    const afterCarolLeaves = await plane.leaveCall(carol, "call-1");
    expect(afterCarolLeaves.state).toBe("ended");
  });

  it("rejects leave from a non-participant", async () => {
    await plane.createCall(alice, { conversationId: "conv-1", inviteeUserIds: ["bob"] });
    await plane.joinCall(bob, "call-1");
    await expect(plane.leaveCall(carol, "call-1")).rejects.toMatchObject({
      name: "CallStateError",
      reason: "notParticipant",
    });
  });

  it("only lets the creator end the call, and end is idempotent", async () => {
    await plane.createCall(alice, { conversationId: "conv-1", inviteeUserIds: ["bob"] });
    await plane.joinCall(bob, "call-1");

    await expect(plane.endCall(bob, "call-1")).rejects.toMatchObject({
      name: "CallAuthzError",
      reason: "notCreator",
    });

    const ended = await plane.endCall(alice, "call-1");
    expect(ended.state).toBe("ended");
    expect(media.hasSession("call-1")).toBe(false);

    // Idempotent: ending again returns the ended room without a second event.
    const again = await plane.endCall(alice, "call-1");
    expect(again.state).toBe("ended");
    const endedCount = (await callEventNames("call-1")).filter((n) => n === "CallEnded").length;
    expect(endedCount).toBe(1);
  });

  it("accepting an invite is allowed before join and idempotent", async () => {
    await plane.createCall(alice, { conversationId: "conv-1", inviteeUserIds: ["bob"] });
    const accepted = await plane.acceptInvite(bob, "call-1");
    expect(accepted.status).toBe("accepted");
    // Re-accepting is a no-op (returns the accepted invite).
    const again = await plane.acceptInvite(bob, "call-1");
    expect(again.status).toBe("accepted");
    const acceptedEvents = (await callEventNames("call-1")).filter(
      (n) => n === "CallInviteAccepted",
    );
    expect(acceptedEvents).toHaveLength(1);
  });

  it("is tenant-scoped: a call in tenant A is invisible to tenant B", async () => {
    const aliceT1: CallActor = { tenantId: "t1", userId: "alice", deviceId: "d" };
    const bobT2: CallActor = { tenantId: "t2", userId: "bob", deviceId: "d" };
    await plane.createCall(aliceT1, { conversationId: "conv-1", inviteeUserIds: ["bob"] });

    // tenant t2 cannot see the room created in t1.
    expect(await plane.getRoom("t2", "call-1")).toBeUndefined();
    // A same-named actor in t2 is not an invitee of t1's call → join fails.
    await expect(plane.joinCall(bobT2, "call-1")).rejects.toMatchObject({
      name: "CallStateError",
      reason: "callNotFound",
    });
  });

  it("surfaces typed errors (CallStateError / CallAuthzError)", async () => {
    await plane.createCall(alice, { conversationId: "conv-1", inviteeUserIds: ["bob"] });
    const notInvited = await plane.joinCall.bind(plane)(carol, "call-1").catch((e) => e);
    expect(notInvited).toBeInstanceOf(CallAuthzError);
    await plane.endCall(alice, "call-1");
    const ended = await plane.joinCall.bind(plane)(bob, "call-1").catch((e) => e);
    expect(ended).toBeInstanceOf(CallStateError);
  });

  // -- audit regressions ---------------------------------------------------

  it("lets the creator join their own call and issues them a media grant (calls-correctness-1)", async () => {
    await plane.createCall(alice, { conversationId: "conv-1", inviteeUserIds: ["bob"] });

    // The creator (no invite row) can join and become a real participant.
    const joined = await plane.joinCall(alice, "call-1");
    expect(joined.participant.userId).toBe("alice");
    expect(joined.participant.state).toBe("joined");
    expect(joined.room.state).toBe("active");
    expect(joined.mediaGrant.callId).toBe("call-1");

    // acceptInvite is a no-op success for the creator (synthetic self-invite).
    const accepted = await plane.acceptInvite(alice, "call-1");
    expect(accepted.status).toBe("accepted");
    expect(accepted.inviteeUserId).toBe("alice");

    // The creator can also set their own media state as a participant.
    const updated = await plane.setMediaState(alice, "call-1", { micEnabled: false });
    expect(updated.micEnabled).toBe(false);
  });

  it("still rejects a non-invitee, non-creator join (calls-correctness-1 guard)", async () => {
    await plane.createCall(alice, { conversationId: "conv-1", inviteeUserIds: ["bob"] });
    await expect(plane.joinCall(carol, "call-1")).rejects.toMatchObject({
      name: "CallAuthzError",
      reason: "notInvitee",
    });
  });

  it("scopes call records to the actor's appId — app B cannot see app A's call (calls-isolation-1)", async () => {
    const aliceA: CallActor = { ...alice, appId: "app-a" };
    const bobA: CallActor = { ...bob, appId: "app-a" };
    const bobB: CallActor = { ...bob, appId: "app-b" };

    await plane.createCall(aliceA, { conversationId: "conv-1", inviteeUserIds: ["bob"] });

    // Same tenant, different app: the room is not visible.
    expect(await plane.getRoom(alice.tenantId, "call-1", "app-b")).toBeUndefined();
    // And the room IS visible within its own app.
    expect((await plane.getRoom(alice.tenantId, "call-1", "app-a"))?.state).toBe("ringing");

    // An invitee connecting under a different app cannot join the app-a call.
    await expect(plane.joinCall(bobB, "call-1")).rejects.toMatchObject({
      name: "CallStateError",
      reason: "callNotFound",
    });

    // The invitee under the correct app joins fine, and its participant record
    // lands in app-a's namespace (not the default app).
    const joined = await plane.joinCall(bobA, "call-1");
    expect(joined.participant.state).toBe("joined");
    expect(await plane.listParticipants(alice.tenantId, "call-1", "app-a")).toHaveLength(1);
    expect(await plane.listParticipants(alice.tenantId, "call-1", "app-b")).toHaveLength(0);
    // Default-app readers also see nothing for an app-scoped call.
    expect(await plane.listParticipants(alice.tenantId, "call-1")).toHaveLength(0);
  });

  it("#finalizeEnd fails closed (callNotFound) when the room vanishes mid-end (calls-stability-1)", async () => {
    // Simulate a delete/end race: the room is readable when leaveCall checks it,
    // but gone by the time #finalizeEnd re-reads it. The guard must throw
    // callNotFound rather than persist a corrupt `{ state, endedAt }` record.
    const realStore = store;
    let roomReads = 0;
    const racingStore = new Proxy(realStore, {
      get(target, prop, receiver) {
        if (prop === "readObject") {
          return (...args: unknown[]) => {
            const [, type, id] = args as [string, string, string];
            // The 2nd read of THIS room (the one inside #finalizeEnd) returns
            // undefined — the room was deleted concurrently.
            if (type === "CallRoom" && id === "race-1") {
              roomReads += 1;
              if (roomReads >= 2) {
                return Promise.resolve(undefined);
              }
            }
            return (target.readObject as (...a: unknown[]) => unknown)(...args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as FrickStore;

    const racingPlane = new CallControlPlane({
      store: racingStore,
      mediaPlane: new FakeMediaPlaneAdapter({ now: () => 1_000 }),
      generateId: () => "race-1",
      now: () => new Date(1_000),
    });

    await racingPlane.createCall(alice, { conversationId: "conv-1", inviteeUserIds: ["bob"] });
    await racingPlane.joinCall(bob, "race-1");
    roomReads = 0; // start counting from the leave flow.

    // leaveCall of the last participant auto-ends → #finalizeEnd re-reads the
    // (now-deleted) room and must fail closed.
    await expect(racingPlane.leaveCall(bob, "race-1")).rejects.toMatchObject({
      name: "CallStateError",
      reason: "callNotFound",
    });
  });

  it("enforces the P2P media plane participant cap of 2 (sfu-media-4)", async () => {
    const p2pMedia = new FakeMediaPlaneAdapter({ transport: "p2p", now: () => 1_000 });
    let ids = 0;
    const p2pPlane = new CallControlPlane({
      store,
      mediaPlane: p2pMedia,
      generateId: () => `p2p-${++ids}`,
      now: () => new Date(1_000),
    });

    // creator + 2 invitees = 3 > 2 → rejected at create time.
    await expect(
      p2pPlane.createCall(alice, { conversationId: "conv-1", inviteeUserIds: ["bob", "carol"] }),
    ).rejects.toMatchObject({ name: "CallStateError", reason: "capacityExceeded" });

    // The rejected create threw before generating an id, so the next call is
    // "p2p-1". creator + 1 invitee = 2 is fine; both can join.
    await p2pPlane.createCall(alice, { conversationId: "conv-1", inviteeUserIds: ["bob"] });
    await p2pPlane.joinCall(alice, "p2p-1");
    await p2pPlane.joinCall(bob, "p2p-1");

    // A third, uninvited user is rejected outright.
    const dave: CallActor = callActor("dave", "dave-web");
    await expect(p2pPlane.joinCall(dave, "p2p-1")).rejects.toMatchObject({
      name: "CallAuthzError",
      reason: "notInvitee",
    });
    // A re-join by an already-joined participant is a free seat (no cap trip).
    await expect(p2pPlane.joinCall(bob, "p2p-1")).resolves.toBeDefined();
  });

  // -- FR-155: SFU media negotiation forwarding ----------------------------

  describe("FR-155 — SFU produce/consume forwarding", () => {
    let backend: FakeSfuBackend;
    let sfuPlane: CallControlPlane;

    /** Pull a participant's transport ids out of their join grant. */
    function grantTransports(connection: Readonly<Record<string, string>>): {
      send: string;
      recv: string;
    } {
      const send = JSON.parse(connection["sendTransport"]!) as SfuTransportParams;
      const recv = JSON.parse(connection["recvTransport"]!) as SfuTransportParams;
      return { send: send.id, recv: recv.id };
    }

    beforeEach(() => {
      backend = new FakeSfuBackend();
      const sfuMedia = new SfuMediaPlaneAdapter({
        backend,
        announcedIp: "203.0.113.9",
        mediaCodecs: DEFAULT_SFU_MEDIA_CODECS,
        tokenSecret: "test-secret-at-least-16-bytes",
        now: () => 1_000,
      });
      idCounter = 0;
      sfuPlane = new CallControlPlane({
        store,
        mediaPlane: sfuMedia,
        generateId: () => `call-${++idCounter}`,
        now: () => new Date(1_000),
      });
    });

    async function joinedCall(): Promise<{
      callId: string;
      send: string;
      recv: string;
      token: string;
    }> {
      await sfuPlane.createCall(alice, { conversationId: "conv-1", inviteeUserIds: ["bob"] });
      const joined = await sfuPlane.joinCall(bob, "call-1");
      const { send, recv } = grantTransports(joined.mediaGrant.connection!);
      return { callId: "call-1", send, recv, token: joined.mediaGrant.token };
    }

    it("connects a transport, produces a track, and consumes a remote producer", async () => {
      const { callId, send, recv, token } = await joinedCall();

      // connectTransport forwards to the backend (transport becomes connected).
      await sfuPlane.sfuConnectTransport(bob, callId, token, send, {
        fingerprints: [{ algorithm: "sha-256", value: "AA:BB" }],
      });

      // produce → a server-assigned producer id.
      const producer = await sfuPlane.sfuProduce(bob, callId, token, send, "audio", {
        codecs: [{ payloadType: 111 }],
      });
      expect(producer.id).toMatch(/^fake-producer-/);
      expect(producer.kind).toBe("audio");

      // consume that producer onto the recv transport → a consumer w/ rtpParameters.
      const consumer = await sfuPlane.sfuConsume(bob, callId, token, recv, producer.id, {
        codecs: ["client-caps"],
      });
      expect(consumer.producerId).toBe(producer.id);
      expect(consumer.kind).toBe("audio");
      expect(consumer.rtpParameters).toMatchObject({ encodings: expect.any(Array) });
    });

    it("rejects SFU ops from a non-participant (notParticipant)", async () => {
      const { callId, send, token } = await joinedCall();
      await expect(
        sfuPlane.sfuProduce(carol, callId, token, send, "audio", {}),
      ).rejects.toMatchObject({ name: "CallStateError", reason: "notParticipant" });
    });

    it("rejects SFU ops on an ended call", async () => {
      const { callId, send, token } = await joinedCall();
      await sfuPlane.endCall(alice, callId);
      await expect(
        sfuPlane.sfuConnectTransport(bob, callId, token, send, { fingerprints: [] }),
      ).rejects.toBeInstanceOf(CallStateError);
    });

    it("Nacks SFU ops on a non-SFU (P2P/fake) media plane", async () => {
      // `plane` (from the outer suite) uses the FakeMediaPlaneAdapter, which has
      // no produce/consume companion → CallMediaUnsupportedError.
      await plane.createCall(alice, { conversationId: "conv-1", inviteeUserIds: ["bob"] });
      await plane.joinCall(bob, "call-1");
      const error = await plane
        .sfuProduce(bob, "call-1", "tok", "t", "audio", {})
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CallMediaUnsupportedError);
      expect((error as CallMediaUnsupportedError).reason).toBe("sfuUnsupported");
    });
  });
});
