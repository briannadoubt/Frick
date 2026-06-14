import { describe, expect, it } from "vitest";
import { productTestSchema, generateKotlinArtifact, generateSwiftArtifact } from "../src/index.js";

describe("native artifacts", () => {
  it("generates Swift DTO names for objects, events, presence, and signals", () => {
    const swift = generateSwiftArtifact(productTestSchema);

    expect(swift).toContain('public static let schemaId = "frick-product-test"');
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
    const kotlin = generateKotlinArtifact(productTestSchema);

    expect(kotlin).toContain('const val FRICK_SCHEMA_ID: String = "frick-product-test"');
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
    const swift = generateSwiftArtifact(productTestSchema);
    const kotlin = generateKotlinArtifact(productTestSchema);

    expect(swift).toContain("avatarBlobId: String? = nil");
    expect(swift).toContain("attachmentBlobIds: FrickJSONValue? = nil");
    expect(kotlin).toContain("val avatarBlobId: String? = null");
    expect(kotlin).toContain("val attachmentBlobIds: JsonElement? = null");
  });

  it("maps timestamp fields to the FrickTimestamp wrapper in native DTOs", () => {
    const swift = generateSwiftArtifact(productTestSchema);
    const kotlin = generateKotlinArtifact(productTestSchema);

    expect(swift).toContain("public var expiresAt: FrickTimestamp");
    expect(swift).toContain("lastSeenAt: FrickTimestamp? = nil");
    // The wrapper owns the RFC3339 codec; no naive `Date`/`String` field.
    expect(swift).not.toContain("public var expiresAt: Date");
    expect(swift).not.toContain("public var expiresAt: String");
    expect(kotlin).toContain("val expiresAt: FrickTimestamp");
    expect(kotlin).toContain("val lastSeenAt: FrickTimestamp? = null");
  });

  it("emits the FrickTimestamp wrapper + imports when schema has timestamp fields", () => {
    const swift = generateSwiftArtifact(productTestSchema);
    const kotlin = generateKotlinArtifact(productTestSchema);

    // Swift: a Codable wrapper that round-trips the raw RFC3339 string verbatim
    // (singleValueContainer) and exposes a parsed `date`.
    expect(swift).toContain("public struct FrickTimestamp: Codable, Equatable, Sendable");
    expect(swift).toContain("public let rawValue: String");
    expect(swift).toContain("var container = encoder.singleValueContainer()");
    expect(swift).toContain("public var date: Date?");

    // Kotlin: an inline value class (serializes as the bare string) exposing
    // `instant`, gated behind its java.time + Serializable imports.
    expect(kotlin).toContain("import java.time.Instant");
    expect(kotlin).toContain("import java.time.OffsetDateTime");
    expect(kotlin).toContain("import java.time.format.DateTimeParseException");
    expect(kotlin).toContain("import kotlinx.serialization.Serializable");
    expect(kotlin).toContain("value class FrickTimestamp(val rawValue: String)");
    expect(kotlin).toContain("val instant: Instant?");
  });

  it("re-encodes a generated FrickTimestamp wrapper byte-identically (Swift codec shape)", () => {
    // The Swift wrapper stores `rawValue` verbatim and re-emits it through a
    // single-value container, so an RFC3339 value with fractional seconds and a
    // non-Z offset round-trips losslessly. We assert the emitted codec is the
    // verbatim store/emit shape that guarantees that (the executable decode↔
    // encode round-trip lives in the Swift/Kotlin suites).
    const swift = generateSwiftArtifact(productTestSchema);
    expect(swift).toContain("self.rawValue = try container.decode(String.self)");
    expect(swift).toContain("try container.encode(rawValue)");
  });

  it("emits Swift schema descriptor tables for objects, streams, and events", () => {
    const swift = generateSwiftArtifact(productTestSchema);

    expect(swift).toContain("public enum FrickSchemaDescriptor");
    expect(swift).toContain("public static let objectNames: [Int: String]");
    expect(swift).toContain("public static let streamNames: [Int: String]");
    expect(swift).toContain("public static let eventNames: [Int: String]");
    expect(swift).toContain("public static let objectFields: [Int: [Int: String]]");
    expect(swift).toContain("public static let eventFields: [Int: [Int: String]]");
    expect(swift).toMatch(/"MessageSent"/);
    expect(swift).toMatch(/"MessageStream"/);
  });

  it("emits Kotlin schema descriptor tables for objects, streams, and events", () => {
    const kotlin = generateKotlinArtifact(productTestSchema);

    expect(kotlin).toContain("internal val FRICK_OBJECT_NAMES: Map<Int, String>");
    expect(kotlin).toContain("internal val FRICK_STREAM_NAMES: Map<Int, String>");
    expect(kotlin).toContain("internal val FRICK_EVENT_NAMES: Map<Int, String>");
    expect(kotlin).toContain("internal val FRICK_OBJECT_FIELDS: Map<Int, Map<Int, String>>");
    expect(kotlin).toContain("internal val FRICK_EVENT_FIELDS: Map<Int, Map<Int, String>>");
    expect(kotlin).toMatch(/"MessageSent"/);
    expect(kotlin).toMatch(/"MessageStream"/);
  });

  it("emits native JSON value support when schema fields use json", () => {
    const swift = generateSwiftArtifact(productTestSchema);
    const kotlin = generateKotlinArtifact(productTestSchema);

    expect(swift).toContain("public indirect enum FrickJSONValue");
    expect(swift).toContain("case array([FrickJSONValue])");
    expect(swift).toContain("case object([String: FrickJSONValue])");
    expect(kotlin).toContain("import kotlinx.serialization.json.JsonElement");
  });
});
