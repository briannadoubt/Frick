import { definePlatformEventPipelineConformance } from "./platform-events.conformance.js";
import { MemoryPlatformEventPipeline } from "../src/platform-events/memory.js";

definePlatformEventPipelineConformance({
  name: "memory",
  async create() {
    return new MemoryPlatformEventPipeline({
      now: () => new Date("2026-05-17T00:00:00.000Z"),
    });
  },
});
