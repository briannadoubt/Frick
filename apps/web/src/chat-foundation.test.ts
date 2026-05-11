import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildDemoAttachment,
  computeSha256ContentHash,
  createBlobMetadataPayload,
  createConversation,
  devLogin,
  deriveInboxItems,
  drainHttpSignals,
  login,
  nextReadReceiptPayload,
  postHttpSignal,
  sentMessageEvents,
  signUp,
  syncDemoAttachment,
  type ChatMessageEvent,
  type ChatStreamEvent,
  type Conversation,
  type DemoAttachment,
} from "./chat-foundation.js";

const conversations: Conversation[] = [
  {
    id: "conversation-general",
    kind: "channel",
    title: "Foundation General",
    createdBy: "user-ada",
  },
  {
    id: "conversation-design",
    kind: "channel",
    title: "Design",
    createdBy: "user-ada",
  },
];

afterEach(() => {
  vi.useRealTimers();
});

describe("deriveInboxItems", () => {
  test("prefers remote inbox rows while preserving local conversation titles", () => {
    const items = deriveInboxItems({
      conversations,
      inboxRows: [
        {
          conversationId: "conversation-general",
          lastSequence: 12,
          readSequence: 4,
          unreadCount: 3,
        },
      ],
      localMessages: [],
      selectedConversationId: "conversation-general",
      readSequences: {},
    });

    expect(items).toEqual([
      expect.objectContaining({
        conversationId: "conversation-general",
        title: "Foundation General",
        preview: "No messages yet",
        unreadCount: 3,
        lastSequence: 12,
        readSequence: 4,
        selected: true,
      }),
      expect.objectContaining({
        conversationId: "conversation-design",
        title: "Design",
      }),
    ]);
  });

  test("derives preview and unread count from locally known selected conversation messages", () => {
    const items = deriveInboxItems({
      conversations,
      inboxRows: [],
      localMessages: [
        message("event-1", 1, "user-grace", "First"),
        message("event-2", 2, "user-grace", "Latest"),
      ],
      selectedConversationId: "conversation-general",
      readSequences: { "conversation-general": 1 },
    });

    expect(items[0]).toEqual(
      expect.objectContaining({
        conversationId: "conversation-general",
        preview: "Latest",
        unreadCount: 1,
        lastSequence: 2,
        readSequence: 1,
      }),
    );
  });

  test("lets local read state overtake a stale selected remote row", () => {
    const items = deriveInboxItems({
      conversations,
      inboxRows: [
        {
          conversationId: "conversation-general",
          lastSequence: 1,
          readSequence: 0,
          unreadCount: 1,
        },
      ],
      localMessages: [message("event-1", 1, "user-grace", "Read locally")],
      selectedConversationId: "conversation-general",
      readSequences: { "conversation-general": 1 },
    });

    expect(items[0]).toEqual(
      expect.objectContaining({
        readSequence: 1,
        unreadCount: 0,
      }),
    );
  });
});

describe("sentMessageEvents", () => {
  test("filters read receipts out of UI messages", () => {
    const events: ChatStreamEvent[] = [
      message("event-1", 1, "user-grace", "Hello"),
      {
        eventId: "event-2",
        stream: "MessageStream",
        streamId: "conversation-general",
        event: "ReceiptAdvanced",
        sequence: 2,
        payload: {
          userId: "user-ada",
          sequence: 1,
        },
      },
    ];

    expect(sentMessageEvents(events)).toEqual([events[0]]);
  });
});

describe("nextReadReceiptPayload", () => {
  test("advances to the latest message sequence only when it moves forward", () => {
    const payload = nextReadReceiptPayload({
      userId: "user-ada",
      messages: [message("event-1", 1, "user-grace", "Hello")],
      lastSentSequence: 0,
    });

    expect(payload).toEqual({ userId: "user-ada", sequence: 1 });
    expect(
      nextReadReceiptPayload({
        userId: "user-ada",
        messages: [message("event-1", 1, "user-grace", "Hello")],
        lastSentSequence: 1,
      }),
    ).toBeNull();
  });
});

describe("buildDemoAttachment", () => {
  test("creates byte-backed metadata suitable for a message attachment marker", async () => {
    const attachment = await buildDemoAttachment();

    expect(attachment).toEqual(
      expect.objectContaining({
        name: "demo-notes.txt",
        mimeType: "text/plain",
      }),
    );
    expect(attachment.blobId).toMatch(/^blob-demo-/);
    expect(attachment.bytes.byteLength).toBeGreaterThan(0);
    expect(attachment.byteLength).toBe(attachment.bytes.byteLength);
    await expect(computeSha256ContentHash(attachment.bytes)).resolves.toBe(attachment.contentHash);
    expect(attachment.contentHash).toMatch(/^sha256-[0-9a-f]{64}$/);
  });
});

describe("computeSha256ContentHash", () => {
  test("computes sha256-prefixed hex for attachment bytes", async () => {
    await expect(computeSha256ContentHash(new TextEncoder().encode("hello world"))).resolves.toBe(
      "sha256-b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });
});

describe("blob metadata helpers", () => {
  const attachment: DemoAttachment = {
    blobId: "blob-demo-1",
    name: "demo-notes.txt",
    byteLength: 11,
    mimeType: "text/plain",
    contentHash: "sha256-b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    bytes: new TextEncoder().encode("hello world"),
  };

  test("builds the flat metadata body expected by the server", () => {
    expect(createBlobMetadataPayload(attachment, "user-ada")).toEqual({
      blobId: "blob-demo-1",
      ownerId: "user-ada",
      contentHash: "sha256-b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
      byteLength: 11,
      mimeType: "text/plain",
    });
  });

  test("posts metadata, uploads bytes, and downloads bytes when requested", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = async (input: URL, init?: RequestInit) => {
      calls.push({ url: input.toString(), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ ok: true, blobId: attachment.blobId }), { status: 201 });
      }
      if (calls.length === 2) {
        return new Response(null, { status: 204 });
      }
      return new Response(arrayBufferCopy(attachment.bytes), { status: 200 });
    };

    await expect(
      syncDemoAttachment({
        httpEndpoint: "http://127.0.0.1:4099/",
        attachment,
        ownerId: "user-ada",
        downloadContent: true,
        fetchImpl,
      }),
    ).resolves.toMatchObject({
      metadata: createBlobMetadataPayload(attachment, "user-ada"),
      downloadedBytes: attachment.bytes,
    });
    expect(calls).toHaveLength(3);
    const [createCall, uploadCall, downloadCall] = calls;
    if (!createCall || !uploadCall || !downloadCall) {
      throw new Error("Expected create, upload, and download calls");
    }
    expect(createCall.url).toBe("http://127.0.0.1:4099/blobs");
    expect(createCall.init?.method).toBe("POST");
    expect(JSON.parse(String(createCall.init?.body))).toEqual(createBlobMetadataPayload(attachment, "user-ada"));
    expect(uploadCall.url).toBe("http://127.0.0.1:4099/blobs/blob-demo-1/content");
    expect(uploadCall.init?.method).toBe("PUT");
    expect(uploadCall.init?.headers).toEqual({ "content-type": "text/plain" });
    await expect(readRequestBodyBytes(uploadCall.init?.body)).resolves.toEqual(attachment.bytes);
    expect(downloadCall.url).toBe("http://127.0.0.1:4099/blobs/blob-demo-1/content");
    expect(downloadCall.init?.method).toBeUndefined();
  });

  test("sends authorization headers for attachment metadata and content requests", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = async (input: URL, init?: RequestInit) => {
      calls.push({ url: input.toString(), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ ok: true, blobId: attachment.blobId }), { status: 201 });
      }
      if (calls.length === 2) {
        return new Response(null, { status: 204 });
      }
      return new Response(arrayBufferCopy(attachment.bytes), { status: 200 });
    };

    await syncDemoAttachment({
      httpEndpoint: "http://127.0.0.1:4099/",
      attachment,
      ownerId: "user-ada",
      downloadContent: true,
      sessionToken: "session-token-123",
      fetchImpl,
    });

    expect(calls).toHaveLength(3);
    expect(headersObject(calls[0]?.init?.headers)).toEqual({
      authorization: "Bearer session-token-123",
      "content-type": "application/json",
    });
    expect(headersObject(calls[1]?.init?.headers)).toEqual({
      authorization: "Bearer session-token-123",
      "content-type": "text/plain",
    });
    expect(headersObject(calls[2]?.init?.headers)).toEqual({
      authorization: "Bearer session-token-123",
    });
  });
});

describe("devLogin", () => {
  test("posts the dev session body and parses the server response", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const responseBody = {
      schemaHash: "schema-hash",
      sessionToken: "session-token-123",
      userId: "user-ada",
      deviceId: "device-web",
      replicaId: "replica-web",
      expiresAt: "2026-05-09T13:00:00.000Z",
    };
    const fetchImpl = async (input: URL, init?: RequestInit) => {
      calls.push({ url: input.toString(), init });
      return new Response(JSON.stringify(responseBody), { status: 200 });
    };

    await expect(
      devLogin({
        httpEndpoint: "http://127.0.0.1:4099/",
        userId: "user-ada",
        deviceId: "device-web",
        replicaId: "replica-web",
        platform: "web",
        fetchImpl,
      }),
    ).resolves.toEqual(responseBody);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4099/auth/dev-login");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(headersObject(calls[0]?.init?.headers)).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      userId: "user-ada",
      deviceId: "device-web",
      replicaId: "replica-web",
      platform: "web",
    });
  });
});

describe("account auth helpers", () => {
  test("signUp posts account details and parses the server session", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const responseBody = {
      schemaHash: "schema-hash",
      sessionToken: "session-token-new",
      userId: "user-dorothy",
      displayName: "Dorothy Vaughan",
      handle: "dorothy",
      deviceId: "device-web",
      replicaId: "replica-web",
      expiresAt: "2026-05-09T13:00:00.000Z",
    };
    const fetchImpl = async (input: URL, init?: RequestInit) => {
      calls.push({ url: input.toString(), init });
      return new Response(JSON.stringify(responseBody), { status: 201 });
    };

    await expect(
      signUp({
        httpEndpoint: "http://127.0.0.1:4099/",
        displayName: "Dorothy Vaughan",
        handle: "dorothy",
        password: "correct horse battery staple",
        deviceId: "device-web",
        replicaId: "replica-web",
        platform: "web",
        fetchImpl,
      }),
    ).resolves.toEqual(responseBody);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4099/auth/signup");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(headersObject(calls[0]?.init?.headers)).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      displayName: "Dorothy Vaughan",
      handle: "dorothy",
      password: "correct horse battery staple",
      deviceId: "device-web",
      replicaId: "replica-web",
      platform: "web",
    });
  });

  test("signUp aborts stalled account requests", async () => {
    vi.useFakeTimers();
    const fetchImpl = (_input: URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("Missing abort signal"));
          return;
        }
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });

    const promise = signUp({
      httpEndpoint: "http://127.0.0.1:4099/",
      displayName: "Dorothy Vaughan",
      handle: "dorothy",
      password: "correct horse battery staple",
      fetchImpl,
      timeoutMs: 25,
    });

    const assertion = expect(promise).rejects.toThrow("Signup timed out");
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });

  test("signUp surfaces server validation messages", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "signup_rejected", message: "Handle is already taken" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });

    await expect(
      signUp({
        httpEndpoint: "http://127.0.0.1:4099/",
        displayName: "Dorothy Vaughan",
        handle: "dorothy",
        password: "correct horse battery staple",
        fetchImpl,
      }),
    ).rejects.toThrow("Handle is already taken");
  });

  test("login posts credentials and parses the server session", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const responseBody = {
      schemaHash: "schema-hash",
      sessionToken: "session-token-existing",
      userId: "user-dorothy",
      displayName: "Dorothy Vaughan",
      handle: "dorothy",
      deviceId: "device-web",
      replicaId: "replica-web",
      expiresAt: "2026-05-09T13:00:00.000Z",
    };
    const fetchImpl = async (input: URL, init?: RequestInit) => {
      calls.push({ url: input.toString(), init });
      return new Response(JSON.stringify(responseBody), { status: 200 });
    };

    await expect(
      login({
        httpEndpoint: "http://127.0.0.1:4099/",
        identity: "dorothy",
        password: "correct horse battery staple",
        deviceId: "device-web",
        replicaId: "replica-web",
        platform: "web",
        fetchImpl,
      }),
    ).resolves.toEqual(responseBody);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4099/auth/login");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(headersObject(calls[0]?.init?.headers)).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      identity: "dorothy",
      password: "correct horse battery staple",
      deviceId: "device-web",
      replicaId: "replica-web",
      platform: "web",
    });
  });

  test("login surfaces shared error envelope messages", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "auth.unauthenticated",
            message: "Nope",
            requestId: "login_rejected",
            retryable: false,
          },
        }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      );

    await expect(
      login({
        httpEndpoint: "http://127.0.0.1:4099/",
        identity: "dorothy",
        password: "correct horse battery staple",
        fetchImpl,
      }),
    ).rejects.toThrow("Nope");
  });
});

describe("conversation helpers", () => {
  test("createConversation posts thread participants with session authorization", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const responseBody = {
      schemaHash: "schema-hash",
      conversation: {
        id: "conversation-launch-room-a1b2",
        kind: "group",
        title: "Launch Room",
        createdBy: "user-ada",
      },
      member: {
        id: "member-launch-room-a1b2-ada",
        conversationId: "conversation-launch-room-a1b2",
        userId: "user-ada",
        role: "owner",
      },
      members: [
        {
          id: "member-launch-room-a1b2-ada",
          conversationId: "conversation-launch-room-a1b2",
          userId: "user-ada",
          role: "owner",
        },
        {
          id: "member-launch-room-a1b2-grace",
          conversationId: "conversation-launch-room-a1b2",
          userId: "user-grace",
          role: "member",
        },
      ],
    };
    const fetchImpl = async (input: URL, init?: RequestInit) => {
      calls.push({ url: input.toString(), init });
      return new Response(JSON.stringify(responseBody), { status: 201 });
    };

    await expect(
      createConversation({
        httpEndpoint: "http://127.0.0.1:4099/",
        title: "Launch Room",
        kind: "group",
        participantUserIds: ["user-grace"],
        sessionToken: "session-token-123",
        fetchImpl,
      }),
    ).resolves.toEqual(responseBody);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4099/conversations");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(headersObject(calls[0]?.init?.headers)).toEqual({
      authorization: "Bearer session-token-123",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      title: "Launch Room",
      kind: "group",
      participantUserIds: ["user-grace"],
    });
  });
});

describe("HTTP signal helpers", () => {
  test("posts and drains JSON signals through the HTTP endpoint", async () => {
    const signal = { senderDeviceId: "web-device", kind: "offer", sdp: "demo" };
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = async (input: URL, init?: RequestInit) => {
      calls.push({ url: input.toString(), init });
      if (init?.method === "POST") {
        return new Response(null, { status: 202 });
      }
      return new Response(
        JSON.stringify({
          schemaHash: "schema-hash",
          name: "WebRTCSignal",
          key: "conversation/general",
          data: [signal],
        }),
        { status: 200 },
      );
    };

    await postHttpSignal({
      httpEndpoint: "http://127.0.0.1:4099",
      name: "WebRTCSignal",
      key: "conversation/general",
      signal,
      fetchImpl,
    });
    await expect(
      drainHttpSignals({
        httpEndpoint: "http://127.0.0.1:4099",
        name: "WebRTCSignal",
        key: "conversation/general",
        fetchImpl,
      }),
    ).resolves.toEqual([signal]);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4099/signals/WebRTCSignal/conversation%2Fgeneral");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(signal);
    expect(calls[1]?.url).toBe("http://127.0.0.1:4099/signals/WebRTCSignal/conversation%2Fgeneral");
  });
});

async function readRequestBodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (!body) {
    throw new Error("Expected request body");
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }
  throw new Error(`Unsupported request body ${Object.prototype.toString.call(body)}`);
}

function message(eventId: string, sequence: number, senderId: string, body: string): ChatMessageEvent {
  return {
    eventId,
    stream: "MessageStream",
    streamId: "conversation-general",
    event: "MessageSent",
    sequence,
    payload: {
      messageId: `message-${eventId}`,
      senderId,
      body,
      createdAt: "2026-05-09T12:00:00.000Z",
    },
  };
}

function arrayBufferCopy(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function headersObject(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}
