import { describe, expect, it } from "vitest";
import { foundationSchema, generateKotlinArtifact, generateSwiftArtifact } from "../src/index.js";

describe("native artifacts", () => {
  it("generates Swift DTO names for objects, events, presence, and signals", () => {
    const swift = generateSwiftArtifact(foundationSchema);

    expect(swift).toContain("public struct UserDTO");
    expect(swift).toContain("public struct MessageSentDTO");
    expect(swift).toContain("public struct TypingStateDTO");
    expect(swift).toContain("public struct WebRTCSignalDTO");
  });

  it("generates Kotlin DTO names for objects, events, presence, and signals", () => {
    const kotlin = generateKotlinArtifact(foundationSchema);

    expect(kotlin).toContain("data class UserDto");
    expect(kotlin).toContain("data class MessageSentDto");
    expect(kotlin).toContain("data class TypingStateDto");
    expect(kotlin).toContain("data class WebRtcSignalDto");
  });
});
