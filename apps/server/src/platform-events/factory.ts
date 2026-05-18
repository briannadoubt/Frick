import type { FrickConfig } from "../config.js";
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
    if (!input.kafkaFactory) {
      throw new Error("Kafka platform events require a kafkaFactory until the Kafka adapter is wired");
    }
    return input.kafkaFactory();
  }
  return input.sqlite;
}
