/**
 * Cross-device draft sync verification.
 *
 * Spins up two FrickClient connections against the running dev server
 * as the same user (i.e. simulating two devices), each subscribed to
 * `MessageDraft`. Writes a body from client A; asserts client B sees
 * it. Writes from B; asserts A sees the update. Then exits 0.
 *
 *   pnpm tsx scripts/verify-draft-sync.ts
 *
 * Requires the dev server on its default `127.0.0.1:4099` listener
 * (`pnpm server`). Uses the demo `/auth/dev-login` route, which is
 * enabled in dev mode.
 */
import { foundationSchema } from "../packages/protocol/src/index.js";
import { FrickClient, FrickObjectConflictError, type FrickSession } from "../packages/core/src/index.js";
import { OptimisticConflictError } from "../packages/core/src/optimistic.js";

const SERVER = "http://127.0.0.1:4099";
const USER = "user-ada";
const CONVO = "conversation-general";

interface MessageDraftRow {
  id: string;
  userId: string;
  conversationId: string;
  body: string;
  updatedAt: number;
}

async function devLogin(deviceId: string): Promise<FrickSession> {
  const response = await fetch(`${SERVER}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: USER, deviceId }),
  });
  if (!response.ok) throw new Error(`dev-login failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as FrickSession;
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 3000, label = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = probe();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function findBody(client: FrickClient, draftId: string): string | undefined {
  const row = client
    .objects("MessageDraft")
    .value.find((o): o is MessageDraftRow => (o as MessageDraftRow).id === draftId);
  return row?.body;
}

async function main(): Promise<void> {
  const draftId = `${USER}:${CONVO}`;
  const sessionA = await devLogin("device-A");
  const sessionB = await devLogin("device-B");

  const wsEndpoint = SERVER.replace(/^http/, "ws") + "/_frick/sync";
  const opts = { endpoint: wsEndpoint, schema: foundationSchema };
  const a = new FrickClient({ ...opts, session: sessionA, deviceId: "device-A", replicaId: "device-A" });
  const b = new FrickClient({ ...opts, session: sessionB, deviceId: "device-B", replicaId: "device-B" });

  await Promise.all([a.connect(), b.connect()]);

  // Trigger the object subscription on both sides.
  a.objects<MessageDraftRow>("MessageDraft");
  b.objects<MessageDraftRow>("MessageDraft");

  async function writeDraft(client: FrickClient, body: string): Promise<void> {
    const row: MessageDraftRow = { userId: USER, conversationId: CONVO, body, updatedAt: Date.now() };
    try {
      await client.upsertObject<MessageDraftRow>("MessageDraft", draftId, row, undefined, { optimistic: true });
    } catch (error) {
      // Optimistic-overlay path yields OptimisticConflictError; the
      // non-overlay path yields FrickObjectConflictError. Both carry
      // `actualVersion` — re-issue at that version (last-write-wins).
      if (!(error instanceof OptimisticConflictError) && !(error instanceof FrickObjectConflictError)) throw error;
      await client.upsertObject<MessageDraftRow>("MessageDraft", draftId, row, error.actualVersion, {
        optimistic: true,
      });
    }
  }

  // Round 1: A writes, B observes.
  await writeDraft(a, "from A");
  await waitFor(() => (findBody(b, draftId) === "from A" ? true : undefined), 3000, "B sees 'from A'");
  console.log("✓ A → B: 'from A'");

  // Round 2: B writes, A observes.
  await writeDraft(b, "from B");
  await waitFor(() => (findBody(a, draftId) === "from B" ? true : undefined), 3000, "A sees 'from B'");
  console.log("✓ B → A: 'from B'");

  a.disconnect();
  b.disconnect();
  console.log("draft sync verified across two clients of the same user");
}

main().catch((error: unknown) => {
  console.error("verification failed:", error);
  process.exit(1);
});
