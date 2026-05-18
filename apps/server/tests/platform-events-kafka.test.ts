import { describe } from "vitest";
import { definePlatformEventPipelineConformance } from "./platform-events.conformance.js";
import { KafkaPlatformEventPipeline } from "../src/platform-events/kafka.js";
import type { PlatformEventPipeline } from "../src/platform-events/types.js";

const brokers =
  process.env.FRICK_TEST_KAFKA_BROKERS
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [];

describe.skipIf(brokers.length === 0)("Kafka platform event pipeline", () => {
  definePlatformEventPipelineConformance({
    name: "kafka",
    async create() {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const topic = `frick-platform-events-test-${suffix}`;
      const publisher = new KafkaPlatformEventPipeline({
        brokers,
        topic,
        consumerGroup: `frick-platform-events-publisher-${suffix}`,
      });
      const consumer = new KafkaPlatformEventPipeline({
        brokers,
        topic,
        consumerGroup: `frick-platform-events-consumer-${suffix}`,
      });
      return splitKafkaPipeline(publisher, consumer);
    },
  });
});

function splitKafkaPipeline(
  publisher: KafkaPlatformEventPipeline,
  consumer: KafkaPlatformEventPipeline,
): PlatformEventPipeline {
  return {
    adapter: "kafka",
    publish: (input) => publisher.publish(input),
    claim: async (name, options) => {
      const first = await consumer.claim(name, options);
      if (first.length > 0) return first;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const next = await consumer.claim(name, options);
        if (next.length > 0) return next;
        const health = await consumer.health();
        const row = health.consumers.find((entry) => entry.name === name);
        if (row && options?.availableAt !== undefined && row.pending > 0) return [];
        if (row && options?.availableAt === undefined && row.pending === 0 && row.claimed === 0) return [];
      }
      return [];
    },
    ack: (name, eventId) => consumer.ack(name, eventId),
    retry: (name, eventId, options) => consumer.retry(name, eventId, options),
    deadLetter: (name, eventId, options) => consumer.deadLetter(name, eventId, options),
    health: () => consumer.health(),
    async close() {
      await Promise.all([publisher.close(), consumer.close()]);
    },
  };
}
