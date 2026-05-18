import { FrickConfigError, type FrickConfig } from "../config.js";
import { KafkaPlatformEventPipeline } from "./kafka.js";
import type { PlatformEventPipeline } from "./types.js";

export interface CreatePlatformEventPipelineInput {
  readonly config: FrickConfig;
  readonly sqlite: PlatformEventPipeline;
  readonly kafkaFactory?: () => PlatformEventPipeline;
}

export function createPlatformEventPipeline(
  input: CreatePlatformEventPipelineInput,
): PlatformEventPipeline {
  if (input.config.platformEventsDriver === "kafka") {
    if (input.config.platformEventsKafkaBrokers.length === 0) {
      throw new FrickConfigError(
        "FRICK_PLATFORM_EVENTS_KAFKA_BROKERS is required when FRICK_PLATFORM_EVENTS_DRIVER=kafka",
      );
    }
    if (!input.kafkaFactory) {
      return new KafkaPlatformEventPipeline({
        brokers: input.config.platformEventsKafkaBrokers,
        topic: input.config.platformEventsTopic,
        consumerGroup: "frick-server",
      });
    }
    return input.kafkaFactory();
  }
  return input.sqlite;
}
