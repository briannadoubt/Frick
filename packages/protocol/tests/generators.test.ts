/**
 * Generator output tests. These are intentionally substring/regex assertions
 * rather than full snapshot tests so a benign change (e.g. comment tweak,
 * field reordering) doesn't churn the fixture. The shape-level checks below
 * exercise the contract every downstream consumer (Swift, Kotlin, TS bindings)
 * relies on.
 */
import { describe, expect, it } from "vitest";
import { foundationSchema } from "../src/foundation.js";
import {
  generateKotlinErrorEnum,
  generateSwiftErrorEnum,
  generateTypeScriptBindings,
  generateTypeScriptErrorEnum,
} from "../src/index.js";

describe("error-enum generators", () => {
  it("emits Swift enum with every wire code as a case", () => {
    const swift = generateSwiftErrorEnum();
    expect(swift).toContain("public enum FrickErrorCode: String, Codable, CaseIterable, Sendable");
    expect(swift).toContain('case authUnauthenticated = "auth.unauthenticated"');
    expect(swift).toContain('case storageConflict = "storage.conflict"');
    expect(swift).toContain('case rateLimitExceeded = "rateLimit.exceeded"');
  });

  it("emits Kotlin enum with SCREAMING_SNAKE names and a fromWire helper", () => {
    const kotlin = generateKotlinErrorEnum();
    expect(kotlin).toContain("enum class FrickErrorCode(val wireValue: String)");
    expect(kotlin).toContain('AUTH_UNAUTHENTICATED("auth.unauthenticated"),');
    expect(kotlin).toContain('STORAGE_CONFLICT("storage.conflict"),');
    expect(kotlin).toContain('RATE_LIMIT_EXCEEDED("rateLimit.exceeded"),');
    expect(kotlin).toContain("fun fromWire(value: String?): FrickErrorCode?");
  });

  it("emits TS const array + derived union + membership predicate", () => {
    const ts = generateTypeScriptErrorEnum();
    expect(ts).toContain("export const FRICK_ERROR_CODES = [");
    expect(ts).toContain('"auth.unauthenticated"');
    expect(ts).toContain("export type FrickErrorCode = (typeof FRICK_ERROR_CODES)[number];");
    expect(ts).toContain("export function isFrickErrorCode(value: unknown): value is FrickErrorCode");
  });
});

describe("typescript bindings generator", () => {
  const ts = generateTypeScriptBindings(foundationSchema);

  it("emits one Dto interface per object, event, presence, signal", () => {
    expect(ts).toContain("export interface UserDto");
    expect(ts).toContain("export interface ConversationDto");
    expect(ts).toContain("export interface MessageSentDto");
    expect(ts).toContain("export interface TypingStateDto");
    expect(ts).toContain("export interface WebRTCSignalDto");
  });

  it("emits a tagged-union per stream covering its declared events", () => {
    expect(ts).toContain("export type MessageStreamEvent =");
    expect(ts).toContain('{ event: "MessageSent"; payload: MessageSentDto }');
    expect(ts).toContain('{ event: "MessageEdited"; payload: MessageEditedDto }');
    expect(ts).toContain("export type CallEventStreamEvent =");
  });

  it("emits a FrickBindings interface with one property per schema name", () => {
    expect(ts).toContain("export interface FrickBindings");
    expect(ts).toContain("User: ObjectBinding<UserDto>;");
    expect(ts).toContain("MessageStream: StreamBinding<MessageStreamEvent>;");
    expect(ts).toContain("TypingState: PresenceBinding<TypingStateDto>;");
    expect(ts).toContain("WebRTCSignal: SignalBinding<WebRTCSignalDto>;");
  });

  it("emits field-id lookup tables that consumers can use at runtime", () => {
    expect(ts).toContain("export const OBJECT_FIELD_INDEX");
    expect(ts).toContain("User: { id: 1, fields:");
    expect(ts).toContain("displayName: 1");
    expect(ts).toContain("export const EVENT_FIELD_INDEX");
    expect(ts).toContain("MessageSent: { id: 1, fields:");
    expect(ts).toContain("body: 3");
  });

  it("maps schema enum kinds onto string-literal unions", () => {
    expect(ts).toContain('kind: "dm" | "group" | "channel"');
    expect(ts).toContain('role: "owner" | "member"');
    expect(ts).toContain('platform: "web" | "ios" | "android" | "server"');
  });
});
