import { describe, expect, it } from "vitest";
import type {
  PlatformEventInput,
  PlatformEventPipeline,
} from "../src/platform-events/types.js";

export interface PlatformEventConformanceHarness {
  readonly name: string;
  create(): Promise<PlatformEventPipeline>;
  close?(pipeline: PlatformEventPipeline): Promise<void>;
}

const baseEvent: PlatformEventInput = {
  family: "analytics.user_event",
  name: "message.sent",
  source: "test",
  tenantId: "tenant-a",
  accountId: "account-a",
  payload: { messageId: "message-1" },
  attributes: { platform: "web", beta: true, count: 1 },
};

export function definePlatformEventPipelineConformance(
  harness: PlatformEventConformanceHarness,
): void {
  describe(`${harness.name} platform event pipeline`, () => {
    it("publishes typed events and claims them for a named consumer", async () => {
      const pipeline = await harness.create();
      try {
        const receipt = await pipeline.publish(baseEvent);

        expect(receipt.duplicate).toBe(false);
        expect(receipt.sequence).toBeGreaterThan(0);
        const deliveries = await pipeline.claim("analytics-worker", { batchSize: 10 });
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]?.event).toMatchObject({
          id: receipt.id,
          sequence: receipt.sequence,
          family: "analytics.user_event",
          name: "message.sent",
          tenantId: "tenant-a",
          accountId: "account-a",
          payload: { messageId: "message-1" },
          attributes: { platform: "web", beta: true, count: 1 },
        });
        expect(deliveries[0]?.attempt).toBe(1);
      } finally {
        await harness.close?.(pipeline);
        await pipeline.close();
      }
    });

    it("does not redeliver an acked event to the same consumer", async () => {
      const pipeline = await harness.create();
      try {
        const receipt = await pipeline.publish(baseEvent);
        const [delivery] = await pipeline.claim("analytics-worker");
        expect(delivery?.event.id).toBe(receipt.id);

        await pipeline.ack("analytics-worker", receipt.id);

        expect(await pipeline.claim("analytics-worker")).toEqual([]);
        const secondConsumer = await pipeline.claim("export-worker");
        expect(secondConsumer[0]?.event.id).toBe(receipt.id);
      } finally {
        await harness.close?.(pipeline);
        await pipeline.close();
      }
    });

    it("retries a failed delivery after its availability time", async () => {
      const pipeline = await harness.create();
      try {
        const receipt = await pipeline.publish(baseEvent);
        const [delivery] = await pipeline.claim("analytics-worker");
        expect(delivery?.attempt).toBe(1);

        await pipeline.retry("analytics-worker", receipt.id, {
          error: "temporary failure",
          availableAt: "2099-01-01T00:00:00.000Z",
        });
        expect(
          await pipeline.claim("analytics-worker", { availableAt: "2026-01-01T00:00:00.000Z" }),
        ).toEqual([]);

        const [retry] = await pipeline.claim("analytics-worker", {
          availableAt: "2099-01-01T00:00:00.000Z",
        });
        expect(retry?.event.id).toBe(receipt.id);
        expect(retry?.attempt).toBe(2);
      } finally {
        await harness.close?.(pipeline);
        await pipeline.close();
      }
    });

    it("dead-letters poison events per consumer", async () => {
      const pipeline = await harness.create();
      try {
        const receipt = await pipeline.publish(baseEvent);
        await pipeline.claim("analytics-worker");

        await pipeline.deadLetter("analytics-worker", receipt.id, { error: "bad payload" });

        expect(await pipeline.claim("analytics-worker")).toEqual([]);
        const health = await pipeline.health();
        expect(health.deadLettered).toBeGreaterThanOrEqual(1);
        expect(health.consumers.find((row) => row.name === "analytics-worker")?.deadLettered).toBe(
          1,
        );
      } finally {
        await harness.close?.(pipeline);
        await pipeline.close();
      }
    });

    it("deduplicates publishes by idempotencyKey", async () => {
      const pipeline = await harness.create();
      try {
        const first = await pipeline.publish({ ...baseEvent, idempotencyKey: "dedupe-1" });
        const second = await pipeline.publish({ ...baseEvent, idempotencyKey: "dedupe-1" });

        expect(second.id).toBe(first.id);
        expect(second.sequence).toBe(first.sequence);
        expect(second.duplicate).toBe(true);
        expect(await pipeline.claim("analytics-worker", { batchSize: 10 })).toHaveLength(1);
      } finally {
        await harness.close?.(pipeline);
        await pipeline.close();
      }
    });
  });
}
