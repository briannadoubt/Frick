import { describe, expect, it } from "vitest";
import { foundationSchema, generateKotlinArtifact, generateSwiftArtifact } from "../src/index.js";

describe("native artifacts", () => {
  it("generates Swift DTO names for objects, events, presence, and signals", () => {
    const swift = generateSwiftArtifact(foundationSchema);

    expect(swift).toContain('public static let schemaId = "frick-foundation"');
    expect(swift).toContain('public static let schemaVersion = "0.1.0"');
    expect(swift).toContain("public static let schemaRevision = 1");
    expect(swift).toContain("public static let minimumClientRevision = 1");
    expect(swift).toContain("public static let minimumServerRevision = 1");
    expect(swift).toContain("public struct UserDTO");
    expect(swift).toContain("public struct MessageSentDTO");
    expect(swift).toContain("public struct TypingStateDTO");
    expect(swift).toContain("public struct WebRTCSignalDTO");
  });

  it("generates Kotlin DTO names for objects, events, presence, and signals", () => {
    const kotlin = generateKotlinArtifact(foundationSchema);

    expect(kotlin).toContain('const val FRICK_SCHEMA_ID: String = "frick-foundation"');
    expect(kotlin).toContain('const val FRICK_SCHEMA_VERSION: String = "0.1.0"');
    expect(kotlin).toContain("const val FRICK_SCHEMA_REVISION: Int = 1");
    expect(kotlin).toContain("const val FRICK_MINIMUM_CLIENT_REVISION: Int = 1");
    expect(kotlin).toContain("const val FRICK_MINIMUM_SERVER_REVISION: Int = 1");
    expect(kotlin).toContain("data class UserDto");
    expect(kotlin).toContain("data class MessageSentDto");
    expect(kotlin).toContain("data class TypingStateDto");
    expect(kotlin).toContain("data class WebRtcSignalDto");
  });

  it("defaults optional native DTO constructor fields to nil or null", () => {
    const swift = generateSwiftArtifact(foundationSchema);
    const kotlin = generateKotlinArtifact(foundationSchema);

    expect(swift).toContain("avatarBlobId: String? = nil");
    expect(swift).toContain("attachmentBlobIds: FrickJSONValue? = nil");
    expect(kotlin).toContain("val avatarBlobId: String? = null");
    expect(kotlin).toContain("val attachmentBlobIds: JsonElement? = null");
  });

  it("emits native JSON value support when schema fields use json", () => {
    const swift = generateSwiftArtifact(foundationSchema);
    const kotlin = generateKotlinArtifact(foundationSchema);

    expect(swift).toContain("public indirect enum FrickJSONValue");
    expect(swift).toContain("case array([FrickJSONValue])");
    expect(swift).toContain("case object([String: FrickJSONValue])");
    expect(kotlin).toContain("import kotlinx.serialization.json.JsonElement");
  });
});
