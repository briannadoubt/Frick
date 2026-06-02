# Frick Framework Contract Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the first stable framework contract layer: public boundaries, schema identity/version compatibility, shared error envelopes, capability negotiation shapes, extension registry skeletons, fixture structure, and generated artifact drift checks.

**Architecture:** Keep this milestone contract-first. Protocol types live in `packages/protocol`, server extension registration starts as a typed skeleton in `apps/server`, generated native metadata flows through the existing artifact generator, and docs record public/internal/demo/generated boundaries without creating a starter template.

**Tech Stack:** TypeScript 5.9, Vitest 4, pnpm 10, Node 24, MessagePack frames via `@msgpack/msgpack`, existing Swift/Kotlin artifact generation.

---

## Execution Model

Use subagent-driven execution by default. The coordinator should run one implementation subagent per task, then run a spec-review subagent and a code-review subagent before moving to the next task. Do not run implementation subagents in parallel against `packages/protocol/src/foundation.ts`, `packages/protocol/src/schema.ts`, `packages/protocol/src/frame.ts`, generated native files, `apps/server/src/server.ts`, or `apps/server/src/sync/gateway.ts`.

Safe parallel work during this plan:

- Spec review and code review after an implementation task completes.
- Read-only audits of package boundaries.
- Native artifact inspection after protocol metadata shape is merged.

Do not hand-edit generated files. Regenerate them with `pnpm schema:generate`.

## File Structure

- Create: `docs/framework-boundaries.md`  
  Records current public, internal, demo, and generated surfaces.
- Create: `packages/protocol/src/compatibility.ts`  
  Owns schema identity compatibility comparison.
- Create: `packages/protocol/src/errors.ts`  
  Owns shared framework error codes and envelopes.
- Create: `packages/protocol/src/capabilities.ts`  
  Owns client/server capability types and conservative defaults.
- Create: `packages/protocol/src/fixtures.ts`  
  Owns canonical fixture constructors used by fixture generation/tests.
- Create: `packages/protocol/scripts/generate-fixtures.ts`  
  Writes deterministic JSON fixtures under `packages/protocol/fixtures/`.
- Create: `packages/protocol/tests/compatibility.test.ts`  
  Covers schema compatibility.
- Create: `packages/protocol/tests/errors.test.ts`  
  Covers error envelopes.
- Create: `packages/protocol/tests/capabilities.test.ts`  
  Covers capability defaults and wire shape.
- Create: `packages/protocol/tests/fixtures.test.ts`  
  Covers generated fixture decoding.
- Create: `apps/server/src/extensions.ts`  
  Owns the server extension registry skeleton.
- Create: `apps/server/tests/extensions.test.ts`  
  Covers registry defaults and registration.
- Create: `scripts/check-generated-artifacts.ts`  
  Runs generators and fails when generated files drift.
- Modify: `packages/protocol/src/schema.ts`  
  Adds schema identity/version fields and validation.
- Modify: `packages/protocol/src/foundation.ts`  
  Populates foundation schema identity metadata.
- Modify: `packages/protocol/src/frame.ts`  
  Uses shared error envelope for nacks and adds capability metadata to hello.
- Modify: `packages/protocol/src/artifacts.ts`  
  Emits schema identity metadata into Swift/Kotlin generated artifacts.
- Modify: `packages/protocol/src/index.ts`  
  Exports new protocol modules.
- Modify: `packages/protocol/tests/schema.test.ts`  
  Asserts schema identity metadata.
- Modify: `packages/protocol/tests/frame.test.ts`  
  Asserts hello capability round-trip and nack error envelope round-trip.
- Modify: `packages/protocol/tests/artifacts.test.ts`  
  Asserts generated native metadata.
- Modify: `packages/protocol/package.json`  
  Adds fixture generation script if package-local scripts are used.
- Modify: `apps/server/src/server.ts`  
  Accepts extension registry input in `createFrickServer`.
- Modify: `apps/server/src/sync/gateway.ts`  
  Uses compatibility helper and shared nack envelopes.
- Modify: `package.json`  
  Adds `fixtures:generate` and `verify:generated` scripts.

## Task 1: Boundary Audit Document

**Files:**
- Create: `docs/framework-boundaries.md`

- [ ] **Step 1: Write the boundary document**

Create `docs/framework-boundaries.md` with this content:

```markdown
# Frick Framework Boundaries

Status: Contract baseline audit.

## Public Framework Packages

- `@fricken/protocol`: canonical schema types, codecs, frame types, generated artifact helpers, schema compatibility helpers, shared error envelopes, capability metadata, and protocol fixtures.
- `@fricken/core`: UI-agnostic TypeScript runtime for cache, subscriptions, sync status, offline appends, presence, signals, and schema compatibility behavior.
- `@fricken/react`: React provider and hooks over `@fricken/core`.
- `@fricken/design`: canonical design-token authoring and generation.
- `@fricken/design-web`: reusable React design primitives and workspace shell components.
- `packages/swift`: Swift client SDK package.
- `packages/design-swift`: Swift design package.
- `apps/android/frick`: Android/Kotlin client SDK module.
- `apps/android/design`: Android/Kotlin design module.
- `apps/server`: Frick server runtime. Intended public baseline API is `createFrickServer` plus documented server options; route internals are not public API. A package entry point/export map still needs to formalize this before release.

## Internal Framework Modules

- Server storage implementations under `apps/server/src/storage/*`.
- Server route handlers inside `apps/server/src/server.ts`.
- Sync gateway internals under `apps/server/src/sync/*`.
- Protocol generator scripts under `packages/protocol/scripts/*`.
- Design generator scripts under `packages/design/src/scripts/*`.

Internal modules may change while public package entry points stay stable.

## Demo App Code

- `apps/web`
- `apps/ios/FrickDemo`
- `apps/android/app`

Demo apps prove framework behavior. They must not contain protocol, auth/session, schema compatibility, storage, or generated artifact behavior that real apps would need to copy.

## Generated Files

Generated files must not be hand-edited:

- `packages/swift/Sources/FrickSwift/Generated/FrickGenerated.swift`
- `apps/android/frick/src/main/java/dev/frick/client/FrickGenerated.kt`
- `packages/design-web/src/generated/*`
- `packages/design-swift/Sources/FrickDesign/Generated/*`
- `apps/android/design/src/main/java/dev/frick/design/generated/*`

Regenerate protocol artifacts with `pnpm schema:generate`.
Regenerate design artifacts with `pnpm design:generate`.

## Current Contract Rule

If a real app would need to import code from a demo app or deep internal path, that behavior belongs in a framework package or a documented extension point before release.
```

- [ ] **Step 2: Verify the document exists**

Run:

```bash
test -f docs/framework-boundaries.md
```

Expected: exits successfully.

- [ ] **Step 3: Commit**

```bash
git add docs/framework-boundaries.md
git commit -m "docs: define framework boundaries"
```

## Task 2: Schema Identity Metadata

**Files:**
- Modify: `packages/protocol/src/schema.ts`
- Modify: `packages/protocol/src/foundation.ts`
- Modify: `packages/protocol/tests/schema.test.ts`

- [ ] **Step 1: Write the failing schema metadata tests**

In `packages/protocol/tests/schema.test.ts`, update the stable hash test to assert identity metadata:

```ts
  it("has stable schema identity metadata", () => {
    const schema = validateSchema(foundationSchema);

    expect(schema.name).toBe("frick-foundation");
    expect(schema.schemaId).toBe("frick-foundation");
    expect(schema.schemaVersion).toBe("0.1.0");
    expect(schema.schemaRevision).toBe(1);
    expect(schema.minimumClientRevision).toBe(1);
    expect(schema.minimumServerRevision).toBe(1);
    expect(schema.hash).toMatch(/^frick-foundation-/);
    expect(schema.protocol).toBe("frick.realtime");
    expect(schema.compatibility).toBe("greenfield-cutover");
  });
```

Add this test in the same `describe` block:

```ts
  it("rejects missing or invalid schema identity metadata", () => {
    const missingIdentity = structuredClone(foundationSchema) as Record<string, unknown>;
    delete missingIdentity.schemaId;

    expect(() => validateSchema(missingIdentity as typeof foundationSchema)).toThrow(/schemaId/i);

    const invalidRevision = structuredClone(foundationSchema);
    invalidRevision.schemaRevision = 0;

    expect(() => validateSchema(invalidRevision)).toThrow(/schemaRevision/i);
  });
```

- [ ] **Step 2: Run the schema tests to verify they fail**

Run:

```bash
pnpm exec vitest run packages/protocol/tests/schema.test.ts
```

Expected: fails because `schemaId`, `schemaVersion`, `schemaRevision`, `minimumClientRevision`, and `minimumServerRevision` do not exist yet.

- [ ] **Step 3: Add metadata fields to the schema type and validator**

In `packages/protocol/src/schema.ts`, update `FrickSchema`:

```ts
export interface FrickSchema {
  name: string;
  schemaId: string;
  schemaVersion: string;
  schemaRevision: number;
  minimumClientRevision: number;
  minimumServerRevision: number;
  protocol: "frick.realtime";
  protocolVersion: number;
  compatibility: "greenfield-cutover";
  hash: string;
  objects: ObjectDef[];
  streams: StreamDef[];
  events: EventDef[];
  presences: PresenceDef[];
  signals: SignalDef[];
  blobs: BlobDef[];
  jobs: JobDef[];
  projections: ProjectionDef[];
}
```

Near the start of `validateSchema`, after protocol/compatibility checks, add:

```ts
  validateSchemaIdentity(normalized);
```

Add this helper near the other local validation helpers:

```ts
function validateSchemaIdentity(schema: FrickSchema): void {
  if (!isNonEmptyString(schema.schemaId)) {
    throw new Error("schemaId must be a non-empty string");
  }
  if (!isNonEmptyString(schema.schemaVersion)) {
    throw new Error("schemaVersion must be a non-empty string");
  }
  if (!isPositiveInteger(schema.schemaRevision)) {
    throw new Error("schemaRevision must be a positive integer");
  }
  if (!isPositiveInteger(schema.minimumClientRevision)) {
    throw new Error("minimumClientRevision must be a positive integer");
  }
  if (!isPositiveInteger(schema.minimumServerRevision)) {
    throw new Error("minimumServerRevision must be a positive integer");
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && value > 0;
}
```

- [ ] **Step 4: Populate foundation schema metadata**

In `packages/protocol/src/foundation.ts`, add metadata after `name`:

```ts
  schemaId: "frick-foundation",
  schemaVersion: "0.1.0",
  schemaRevision: 1,
  minimumClientRevision: 1,
  minimumServerRevision: 1,
```

- [ ] **Step 5: Run schema tests**

Run:

```bash
pnpm exec vitest run packages/protocol/tests/schema.test.ts
```

Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/schema.ts packages/protocol/src/foundation.ts packages/protocol/tests/schema.test.ts
git commit -m "feat(protocol): add schema identity metadata"
```

## Task 3: Schema Compatibility Helper

**Files:**
- Create: `packages/protocol/src/compatibility.ts`
- Modify: `packages/protocol/src/index.ts`
- Create: `packages/protocol/tests/compatibility.test.ts`

- [ ] **Step 1: Write the failing compatibility tests**

Create `packages/protocol/tests/compatibility.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  compareSchemaCompatibility,
  foundationSchema,
  requireSchemaCompatibility,
} from "../src/index.js";

describe("schema compatibility", () => {
  it("accepts an exact matching schema", () => {
    expect(compareSchemaCompatibility(foundationSchema, foundationSchema)).toEqual({
      compatible: true,
      reason: "exact",
      clientRevision: 1,
      serverRevision: 1,
    });
  });

  it("rejects a different schema id", () => {
    const client = { ...foundationSchema, schemaId: "other-app" };

    expect(compareSchemaCompatibility(client, foundationSchema)).toEqual({
      compatible: false,
      reason: "schemaIdMismatch",
      clientRevision: 1,
      serverRevision: 1,
      message: "Schema id mismatch: client=other-app server=frick-foundation",
    });
  });

  it("rejects a client below the server minimum revision", () => {
    const client = { ...foundationSchema, schemaRevision: 1 };
    const server = { ...foundationSchema, schemaRevision: 3, minimumClientRevision: 2 };

    expect(compareSchemaCompatibility(client, server)).toEqual({
      compatible: false,
      reason: "clientTooOld",
      clientRevision: 1,
      serverRevision: 3,
      message: "Client schema revision 1 is below server minimum 2",
    });
  });

  it("rejects a server below the client minimum revision", () => {
    const client = { ...foundationSchema, schemaRevision: 3, minimumServerRevision: 2 };
    const server = { ...foundationSchema, schemaRevision: 1 };

    expect(compareSchemaCompatibility(client, server)).toEqual({
      compatible: false,
      reason: "serverTooOld",
      clientRevision: 3,
      serverRevision: 1,
      message: "Server schema revision 1 is below client minimum 2",
    });
  });

  it("accepts compatible revisions but reports hash mismatch", () => {
    const client = { ...foundationSchema, hash: "frick-foundation-compatible-client" };
    const server = { ...foundationSchema, hash: "frick-foundation-compatible-server" };

    expect(compareSchemaCompatibility(client, server)).toEqual({
      compatible: true,
      reason: "revisionCompatibleHashMismatch",
      clientRevision: 1,
      serverRevision: 1,
      message: "Schema revisions are compatible but hashes differ",
    });
  });

  it("throws a useful error when compatibility is required", () => {
    const client = { ...foundationSchema, schemaId: "other-app" };

    expect(() => requireSchemaCompatibility(client, foundationSchema)).toThrow(/schema id mismatch/i);
  });
});
```

- [ ] **Step 2: Run compatibility tests to verify they fail**

Run:

```bash
pnpm exec vitest run packages/protocol/tests/compatibility.test.ts
```

Expected: fails because `compareSchemaCompatibility` and `requireSchemaCompatibility` are not exported.

- [ ] **Step 3: Implement compatibility helper**

Create `packages/protocol/src/compatibility.ts`:

```ts
import type { FrickSchema } from "./schema.js";

export type SchemaCompatibilityReason =
  | "exact"
  | "revisionCompatibleHashMismatch"
  | "schemaIdMismatch"
  | "clientTooOld"
  | "serverTooOld";

export type SchemaCompatibilityResult =
  | {
      compatible: true;
      reason: "exact" | "revisionCompatibleHashMismatch";
      clientRevision: number;
      serverRevision: number;
      message?: string;
    }
  | {
      compatible: false;
      reason: "schemaIdMismatch" | "clientTooOld" | "serverTooOld";
      clientRevision: number;
      serverRevision: number;
      message: string;
    };

export function compareSchemaCompatibility(client: FrickSchema, server: FrickSchema): SchemaCompatibilityResult {
  const clientRevision = client.schemaRevision;
  const serverRevision = server.schemaRevision;

  if (client.schemaId !== server.schemaId) {
    return {
      compatible: false,
      reason: "schemaIdMismatch",
      clientRevision,
      serverRevision,
      message: `Schema id mismatch: client=${client.schemaId} server=${server.schemaId}`,
    };
  }

  if (client.schemaRevision < server.minimumClientRevision) {
    return {
      compatible: false,
      reason: "clientTooOld",
      clientRevision,
      serverRevision,
      message: `Client schema revision ${client.schemaRevision} is below server minimum ${server.minimumClientRevision}`,
    };
  }

  if (server.schemaRevision < client.minimumServerRevision) {
    return {
      compatible: false,
      reason: "serverTooOld",
      clientRevision,
      serverRevision,
      message: `Server schema revision ${server.schemaRevision} is below client minimum ${client.minimumServerRevision}`,
    };
  }

  if (client.hash !== server.hash) {
    return {
      compatible: true,
      reason: "revisionCompatibleHashMismatch",
      clientRevision,
      serverRevision,
      message: "Schema revisions are compatible but hashes differ",
    };
  }

  return {
    compatible: true,
    reason: "exact",
    clientRevision,
    serverRevision,
  };
}

export function requireSchemaCompatibility(client: FrickSchema, server: FrickSchema): SchemaCompatibilityResult {
  const result = compareSchemaCompatibility(client, server);
  if (!result.compatible) {
    throw new Error(result.message);
  }
  return result;
}
```

In `packages/protocol/src/index.ts`, export it:

```ts
export * from "./compatibility.js";
```

- [ ] **Step 4: Run compatibility tests**

Run:

```bash
pnpm exec vitest run packages/protocol/tests/compatibility.test.ts
```

Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/compatibility.ts packages/protocol/src/index.ts packages/protocol/tests/compatibility.test.ts
git commit -m "feat(protocol): add schema compatibility helper"
```

## Task 4: Shared Error Envelope

**Files:**
- Create: `packages/protocol/src/errors.ts`
- Modify: `packages/protocol/src/frame.ts`
- Modify: `packages/protocol/src/index.ts`
- Create: `packages/protocol/tests/errors.test.ts`
- Modify: `packages/protocol/tests/frame.test.ts`
- Modify: `apps/server/src/sync/gateway.ts`

- [ ] **Step 1: Write failing error envelope tests**

Create `packages/protocol/tests/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createFrickErrorEnvelope,
  isFrickErrorEnvelope,
} from "../src/index.js";

describe("frick error envelopes", () => {
  it("creates stable safe error envelopes", () => {
    expect(
      createFrickErrorEnvelope({
        code: "schema.incompatible",
        message: "Schema mismatch",
        requestId: "request-1",
        retryable: false,
        details: { reason: "hashMismatch" },
        schemaRevision: 1,
      }),
    ).toEqual({
      code: "schema.incompatible",
      message: "Schema mismatch",
      requestId: "request-1",
      retryable: false,
      details: { reason: "hashMismatch" },
      schemaRevision: 1,
    });
  });

  it("recognizes valid envelopes and rejects arbitrary objects", () => {
    expect(
      isFrickErrorEnvelope({
        code: "auth.unauthenticated",
        message: "Sign in required",
        requestId: "request-2",
        retryable: false,
      }),
    ).toBe(true);

    expect(isFrickErrorEnvelope({ code: "auth.unauthenticated" })).toBe(false);
  });
});
```

In `packages/protocol/tests/frame.test.ts`, add a nack frame to the round-trip list:

```ts
      [
        FrameKind.Nack,
        {
          requestId: "request-nack",
          error: {
            code: "schema.incompatible",
            message: "Schema mismatch",
            requestId: "request-nack",
            retryable: false,
            schemaRevision: foundationSchema.schemaRevision,
          },
        },
      ],
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm exec vitest run packages/protocol/tests/errors.test.ts packages/protocol/tests/frame.test.ts
```

Expected: fails because `errors.ts` does not exist and `NackPayload` still has `code`/`message` fields instead of `error`.

- [ ] **Step 3: Implement shared error envelope**

Create `packages/protocol/src/errors.ts`:

```ts
export type FrickErrorCode =
  | "auth.unauthenticated"
  | "auth.forbidden"
  | "auth.sessionExpired"
  | "schema.incompatible"
  | "schema.migrationRequired"
  | "storage.conflict"
  | "storage.notFound"
  | "stream.appendRejected"
  | "sync.protocolError"
  | "sync.reconnectExhausted"
  | "blob.tooLarge"
  | "blob.unsupportedContentType"
  | "rateLimit.exceeded"
  | "server.internal";

export interface FrickErrorEnvelope {
  code: FrickErrorCode;
  message: string;
  requestId: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  schemaHash?: string;
  schemaRevision?: number;
}

export function createFrickErrorEnvelope(input: FrickErrorEnvelope): FrickErrorEnvelope {
  return { ...input };
}

export function isFrickErrorEnvelope(value: unknown): value is FrickErrorEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }
  const envelope = value as Partial<FrickErrorEnvelope>;
  return (
    typeof envelope.code === "string" &&
    typeof envelope.message === "string" &&
    typeof envelope.requestId === "string" &&
    typeof envelope.retryable === "boolean"
  );
}
```

In `packages/protocol/src/index.ts`, export it:

```ts
export * from "./errors.js";
```

In `packages/protocol/src/frame.ts`, import `FrickErrorEnvelope` and update `NackPayload`:

```ts
import type { FrickErrorEnvelope } from "./errors.js";
```

```ts
export interface NackPayload {
  requestId: string;
  error: FrickErrorEnvelope;
}
```

- [ ] **Step 4: Update sync gateway nacks**

In `apps/server/src/sync/gateway.ts`, add `createFrickErrorEnvelope` to protocol imports. Replace raw nacks with envelope nacks:

```ts
      sendFrame(socket, [
        FrameKind.Nack,
        {
          requestId: "unknown",
          error: createFrickErrorEnvelope({
            code: "sync.protocolError",
            message: error instanceof Error ? error.message : "Unknown frame error",
            requestId: "unknown",
            retryable: false,
          }),
        },
      ]);
```

For schema mismatch:

```ts
          sendFrame(client.socket, [
            FrameKind.Nack,
            {
              requestId: "hello",
              error: createFrickErrorEnvelope({
                code: "schema.incompatible",
                message: error instanceof Error ? error.message : "Schema mismatch",
                requestId: "hello",
                retryable: false,
                schemaHash: this.store.schema.hash,
                schemaRevision: this.store.schema.schemaRevision,
              }),
            },
          ]);
```

- [ ] **Step 5: Run protocol and server tests**

Run:

```bash
pnpm exec vitest run packages/protocol/tests/errors.test.ts packages/protocol/tests/frame.test.ts apps/server/tests/server.test.ts
```

Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/errors.ts packages/protocol/src/frame.ts packages/protocol/src/index.ts packages/protocol/tests/errors.test.ts packages/protocol/tests/frame.test.ts apps/server/src/sync/gateway.ts
git commit -m "feat(protocol): add shared error envelopes"
```

## Task 5: Capability Negotiation Types

**Files:**
- Create: `packages/protocol/src/capabilities.ts`
- Modify: `packages/protocol/src/frame.ts`
- Modify: `packages/protocol/src/index.ts`
- Create: `packages/protocol/tests/capabilities.test.ts`
- Modify: `packages/protocol/tests/frame.test.ts`

- [ ] **Step 1: Write failing capability tests**

Create `packages/protocol/tests/capabilities.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  defaultClientCapabilities,
  defaultServerCapabilities,
  foundationSchema,
} from "../src/index.js";

describe("capability negotiation metadata", () => {
  it("builds conservative client capabilities", () => {
    expect(
      defaultClientCapabilities({
        platform: "web",
        sdkVersion: "0.0.0-test",
        schema: foundationSchema,
      }),
    ).toEqual({
      platform: "web",
      sdkVersion: "0.0.0-test",
      schema: {
        schemaId: "frick-foundation",
        schemaRevision: 1,
        schemaHash: foundationSchema.hash,
      },
      transports: ["websocket"],
      encodings: ["msgpack"],
      primitives: ["objects", "streams", "presence", "signals"],
      offline: { cache: true, pendingAppends: true },
      blobUploads: ["direct"],
      push: [],
      experimental: [],
      required: [],
    });
  });

  it("builds conservative server capabilities", () => {
    expect(defaultServerCapabilities(foundationSchema)).toEqual({
      schema: {
        schemaId: "frick-foundation",
        schemaRevision: 1,
        schemaHash: foundationSchema.hash,
      },
      transports: ["websocket", "http"],
      encodings: ["msgpack", "json"],
      primitives: ["objects", "streams", "presence", "signals", "blobs", "jobs", "projections"],
      blobUploads: ["direct"],
      push: [],
      experimental: [],
      limits: {},
    });
  });
});
```

In `packages/protocol/tests/frame.test.ts`, update the hello frame payload to include `clientCapabilities`:

```ts
          clientCapabilities: defaultClientCapabilities({
            platform: "web",
            sdkVersion: "0.0.0-test",
            schema: foundationSchema,
          }),
```

Add `defaultClientCapabilities` to imports.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm exec vitest run packages/protocol/tests/capabilities.test.ts packages/protocol/tests/frame.test.ts
```

Expected: fails because capability helpers do not exist and `HelloPayload` does not include `clientCapabilities`.

- [ ] **Step 3: Implement capability types and defaults**

Create `packages/protocol/src/capabilities.ts`:

```ts
import type { FrickSchema } from "./schema.js";

export type FrickClientPlatform = "web" | "node" | "ios" | "macos" | "android" | "test" | "service";
export type FrickTransportCapability = "websocket" | "http" | "sse";
export type FrickEncodingCapability = "msgpack" | "json";
export type FrickPrimitiveCapability =
  | "objects"
  | "streams"
  | "presence"
  | "signals"
  | "blobs"
  | "jobs"
  | "projections";
export type FrickBlobUploadCapability = "direct" | "resumable" | "signedUrl" | "localOnly";
export type FrickPushCapability = "apns" | "fcm" | "webPush" | "test";

export interface FrickSchemaCapability {
  schemaId: string;
  schemaRevision: number;
  schemaHash: string;
}

export interface FrickClientCapabilities {
  platform: FrickClientPlatform;
  sdkVersion: string;
  schema: FrickSchemaCapability;
  transports: FrickTransportCapability[];
  encodings: FrickEncodingCapability[];
  primitives: FrickPrimitiveCapability[];
  offline: {
    cache: boolean;
    pendingAppends: boolean;
  };
  blobUploads: FrickBlobUploadCapability[];
  push: FrickPushCapability[];
  experimental: string[];
  required: string[];
}

export interface FrickServerCapabilities {
  schema: FrickSchemaCapability;
  transports: FrickTransportCapability[];
  encodings: FrickEncodingCapability[];
  primitives: FrickPrimitiveCapability[];
  blobUploads: FrickBlobUploadCapability[];
  push: FrickPushCapability[];
  experimental: string[];
  limits: Record<string, number>;
}

export function schemaCapability(schema: FrickSchema): FrickSchemaCapability {
  return {
    schemaId: schema.schemaId,
    schemaRevision: schema.schemaRevision,
    schemaHash: schema.hash,
  };
}

export function defaultClientCapabilities(input: {
  platform: FrickClientPlatform;
  sdkVersion: string;
  schema: FrickSchema;
}): FrickClientCapabilities {
  return {
    platform: input.platform,
    sdkVersion: input.sdkVersion,
    schema: schemaCapability(input.schema),
    transports: ["websocket"],
    encodings: ["msgpack"],
    primitives: ["objects", "streams", "presence", "signals"],
    offline: { cache: true, pendingAppends: true },
    blobUploads: ["direct"],
    push: [],
    experimental: [],
    required: [],
  };
}

export function defaultServerCapabilities(schema: FrickSchema): FrickServerCapabilities {
  return {
    schema: schemaCapability(schema),
    transports: ["websocket", "http"],
    encodings: ["msgpack", "json"],
    primitives: ["objects", "streams", "presence", "signals", "blobs", "jobs", "projections"],
    blobUploads: ["direct"],
    push: [],
    experimental: [],
    limits: {},
  };
}
```

In `packages/protocol/src/index.ts`, export it:

```ts
export * from "./capabilities.js";
```

In `packages/protocol/src/frame.ts`, import `FrickClientCapabilities` and update `HelloPayload`:

```ts
import type { FrickClientCapabilities } from "./capabilities.js";
```

```ts
export interface HelloPayload {
  replicaId: string;
  deviceId: string;
  schemaHash: string;
  knownCursors: Record<string, number>;
  clientCapabilities?: FrickClientCapabilities;
}
```

Keep `clientCapabilities` optional in this milestone so existing clients keep working while SDKs are updated in the runtime alignment slice.

- [ ] **Step 4: Run capability tests**

Run:

```bash
pnpm exec vitest run packages/protocol/tests/capabilities.test.ts packages/protocol/tests/frame.test.ts
```

Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/capabilities.ts packages/protocol/src/frame.ts packages/protocol/src/index.ts packages/protocol/tests/capabilities.test.ts packages/protocol/tests/frame.test.ts
git commit -m "feat(protocol): add capability metadata"
```

## Task 6: Native Generated Schema Metadata

**Files:**
- Modify: `packages/protocol/src/artifacts.ts`
- Modify: `packages/protocol/tests/artifacts.test.ts`
- Generated by command: `packages/swift/Sources/FrickSwift/Generated/FrickGenerated.swift`
- Generated by command: `apps/android/frick/src/main/java/dev/frick/client/FrickGenerated.kt`

- [ ] **Step 1: Write failing artifact tests**

In `packages/protocol/tests/artifacts.test.ts`, add assertions to the existing Swift/Kotlin artifact tests:

```ts
    expect(swift).toContain('public static let schemaId = "frick-foundation"');
    expect(swift).toContain('public static let schemaVersion = "0.1.0"');
    expect(swift).toContain("public static let schemaRevision = 1");
    expect(swift).toContain("public static let minimumClientRevision = 1");
    expect(swift).toContain("public static let minimumServerRevision = 1");
```

For Kotlin:

```ts
    expect(kotlin).toContain('const val FRICK_SCHEMA_ID: String = "frick-foundation"');
    expect(kotlin).toContain('const val FRICK_SCHEMA_VERSION: String = "0.1.0"');
    expect(kotlin).toContain("const val FRICK_SCHEMA_REVISION: Int = 1");
    expect(kotlin).toContain("const val FRICK_MINIMUM_CLIENT_REVISION: Int = 1");
    expect(kotlin).toContain("const val FRICK_MINIMUM_SERVER_REVISION: Int = 1");
```

- [ ] **Step 2: Run artifact tests to verify they fail**

Run:

```bash
pnpm exec vitest run packages/protocol/tests/artifacts.test.ts
```

Expected: fails because generated artifacts only include schema hash/protocol version today.

- [ ] **Step 3: Emit Swift metadata**

In `packages/protocol/src/artifacts.ts`, update the Swift `FrickSchema` enum block:

```ts
    `  public static let schemaId = ${JSON.stringify(schema.schemaId)}`,
    `  public static let schemaVersion = ${JSON.stringify(schema.schemaVersion)}`,
    `  public static let schemaRevision = ${schema.schemaRevision}`,
    `  public static let minimumClientRevision = ${schema.minimumClientRevision}`,
    `  public static let minimumServerRevision = ${schema.minimumServerRevision}`,
```

Keep `schemaHash` and `protocolVersion`.

- [ ] **Step 4: Emit Kotlin metadata**

In `packages/protocol/src/artifacts.ts`, update the Kotlin artifact constants before `FRICK_SCHEMA_HASH`:

```ts
    `const val FRICK_SCHEMA_ID: String = ${JSON.stringify(schema.schemaId)}`,
    `const val FRICK_SCHEMA_VERSION: String = ${JSON.stringify(schema.schemaVersion)}`,
    `const val FRICK_SCHEMA_REVISION: Int = ${schema.schemaRevision}`,
    `const val FRICK_MINIMUM_CLIENT_REVISION: Int = ${schema.minimumClientRevision}`,
    `const val FRICK_MINIMUM_SERVER_REVISION: Int = ${schema.minimumServerRevision}`,
```

- [ ] **Step 5: Run artifact tests**

Run:

```bash
pnpm exec vitest run packages/protocol/tests/artifacts.test.ts
```

Expected: passes.

- [ ] **Step 6: Regenerate native artifacts**

Run:

```bash
pnpm schema:generate
```

Expected: generated Swift and Kotlin files include the new metadata constants.

- [ ] **Step 7: Commit**

```bash
git add packages/protocol/src/artifacts.ts packages/protocol/tests/artifacts.test.ts packages/swift/Sources/FrickSwift/Generated/FrickGenerated.swift apps/android/frick/src/main/java/dev/frick/client/FrickGenerated.kt
git commit -m "feat(protocol): emit native schema metadata"
```

## Task 7: Extension Registry Skeleton

**Files:**
- Create: `apps/server/src/extensions.ts`
- Modify: `apps/server/src/server.ts`
- Create: `apps/server/tests/extensions.test.ts`

- [ ] **Step 1: Write failing extension registry tests**

Create `apps/server/tests/extensions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createFrickExtensionRegistry,
  type FrickExtensionRegistryInput,
} from "../src/extensions.js";

describe("frick extension registry", () => {
  it("creates empty extension groups by default", () => {
    expect(createFrickExtensionRegistry()).toEqual({
      policies: [],
      projections: [],
      jobs: [],
      blobProcessors: [],
      searchAdapters: [],
      notificationIntents: [],
      observabilityHooks: [],
    });
  });

  it("normalizes provided extension groups without sharing mutable arrays", () => {
    const input: FrickExtensionRegistryInput = {
      policies: [{ id: "policy.test" }],
      projections: [{ id: "projection.test" }],
    };

    const registry = createFrickExtensionRegistry(input);
    input.policies?.push({ id: "policy.mutated" });

    expect(registry.policies).toEqual([{ id: "policy.test" }]);
    expect(registry.projections).toEqual([{ id: "projection.test" }]);
    expect(registry.jobs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run extension tests to verify they fail**

Run:

```bash
pnpm exec vitest run apps/server/tests/extensions.test.ts
```

Expected: fails because `apps/server/src/extensions.ts` does not exist.

- [ ] **Step 3: Implement extension registry skeleton**

Create `apps/server/src/extensions.ts`:

```ts
export interface FrickExtensionRef {
  id: string;
}

export interface FrickExtensionRegistry {
  policies: FrickExtensionRef[];
  projections: FrickExtensionRef[];
  jobs: FrickExtensionRef[];
  blobProcessors: FrickExtensionRef[];
  searchAdapters: FrickExtensionRef[];
  notificationIntents: FrickExtensionRef[];
  observabilityHooks: FrickExtensionRef[];
}

export type FrickExtensionRegistryInput = Partial<FrickExtensionRegistry>;

export function createFrickExtensionRegistry(input: FrickExtensionRegistryInput = {}): FrickExtensionRegistry {
  return {
    policies: [...(input.policies ?? [])],
    projections: [...(input.projections ?? [])],
    jobs: [...(input.jobs ?? [])],
    blobProcessors: [...(input.blobProcessors ?? [])],
    searchAdapters: [...(input.searchAdapters ?? [])],
    notificationIntents: [...(input.notificationIntents ?? [])],
    observabilityHooks: [...(input.observabilityHooks ?? [])],
  };
}
```

- [ ] **Step 4: Accept extensions in server options**

In `apps/server/src/server.ts`, import registry helpers:

```ts
import {
  createFrickExtensionRegistry,
  type FrickExtensionRegistryInput,
} from "./extensions.js";
```

Add `extensions?: FrickExtensionRegistryInput;` to `ServerOptions`.

Inside `createFrickServer`, near store creation, add:

```ts
  const extensions = createFrickExtensionRegistry(options.extensions);
```

Include the registry in the returned app object if `createFrickServer` currently returns an object:

```ts
    extensions,
```

If `createFrickServer` only closes over local values, keep `extensions` local for now and add a test only for the registry module. Do not wire hooks into runtime behavior in this milestone.

- [ ] **Step 5: Run server extension tests and typecheck**

Run:

```bash
pnpm exec vitest run apps/server/tests/extensions.test.ts
pnpm typecheck
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/extensions.ts apps/server/src/server.ts apps/server/tests/extensions.test.ts
git commit -m "feat(server): add extension registry skeleton"
```

## Task 8: Protocol Fixtures And Generated Artifact Drift Checks

**Files:**
- Create: `packages/protocol/src/fixtures.ts`
- Create: `packages/protocol/scripts/generate-fixtures.ts`
- Create after running generator: `packages/protocol/fixtures/foundation-schema.json`
- Create after running generator: `packages/protocol/fixtures/error-envelope.json`
- Create after running generator: `packages/protocol/fixtures/hello-frame.json`
- Create: `packages/protocol/tests/fixtures.test.ts`
- Create: `scripts/check-generated-artifacts.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing fixture tests**

Create `packages/protocol/tests/fixtures.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FrameKind,
  foundationSchema,
  isFrickErrorEnvelope,
  type FrickFrame,
} from "../src/index.js";

const fixturesDir = join(process.cwd(), "packages/protocol/fixtures");

describe("protocol fixtures", () => {
  it("writes foundation schema metadata fixture", () => {
    const fixture = readJson("foundation-schema.json") as typeof foundationSchema;

    expect(fixture.schemaId).toBe(foundationSchema.schemaId);
    expect(fixture.schemaRevision).toBe(foundationSchema.schemaRevision);
    expect(fixture.hash).toBe(foundationSchema.hash);
  });

  it("writes shared error envelope fixture", () => {
    const fixture = readJson("error-envelope.json");

    expect(isFrickErrorEnvelope(fixture)).toBe(true);
    expect(fixture).toMatchObject({
      code: "schema.incompatible",
      requestId: "fixture-error",
      retryable: false,
    });
  });

  it("writes hello frame fixture with client capabilities", () => {
    const fixture = readJson("hello-frame.json") as FrickFrame;

    expect(fixture[0]).toBe(FrameKind.Hello);
    expect(fixture[1]).toMatchObject({
      replicaId: "fixture-replica",
      deviceId: "fixture-device",
      schemaHash: foundationSchema.hash,
    });
  });
});

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
}
```

- [ ] **Step 2: Run fixture tests to verify they fail**

Run:

```bash
pnpm exec vitest run packages/protocol/tests/fixtures.test.ts
```

Expected: fails because fixture files do not exist.

- [ ] **Step 3: Add fixture constructors**

Create `packages/protocol/src/fixtures.ts`:

```ts
import { defaultClientCapabilities } from "./capabilities.js";
import { createFrickErrorEnvelope } from "./errors.js";
import { FrameKind, type FrickFrame } from "./frame.js";
import { foundationSchema } from "./foundation.js";

export function foundationSchemaFixture() {
  return foundationSchema;
}

export function errorEnvelopeFixture() {
  return createFrickErrorEnvelope({
    code: "schema.incompatible",
    message: "Fixture schema mismatch",
    requestId: "fixture-error",
    retryable: false,
    details: { reason: "fixture" },
    schemaHash: foundationSchema.hash,
    schemaRevision: foundationSchema.schemaRevision,
  });
}

export function helloFrameFixture(): FrickFrame {
  return [
    FrameKind.Hello,
    {
      replicaId: "fixture-replica",
      deviceId: "fixture-device",
      schemaHash: foundationSchema.hash,
      knownCursors: {},
      clientCapabilities: defaultClientCapabilities({
        platform: "test",
        sdkVersion: "0.0.0-fixture",
        schema: foundationSchema,
      }),
    },
  ];
}
```

Export it from `packages/protocol/src/index.ts`:

```ts
export * from "./fixtures.js";
```

- [ ] **Step 4: Add fixture generator**

Create `packages/protocol/scripts/generate-fixtures.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  errorEnvelopeFixture,
  foundationSchemaFixture,
  helloFrameFixture,
} from "../src/fixtures.js";

const fixturesDir = join(process.cwd(), "packages/protocol/fixtures");

mkdirSync(fixturesDir, { recursive: true });
writeJson("foundation-schema.json", foundationSchemaFixture());
writeJson("error-envelope.json", errorEnvelopeFixture());
writeJson("hello-frame.json", helloFrameFixture());

function writeJson(name: string, value: unknown): void {
  writeFileSync(join(fixturesDir, name), `${JSON.stringify(value, null, 2)}\n`);
}
```

- [ ] **Step 5: Add root scripts**

In root `package.json`, add scripts:

```json
"fixtures:generate": "tsx packages/protocol/scripts/generate-fixtures.ts",
"verify:generated": "tsx scripts/check-generated-artifacts.ts"
```

Keep existing scripts unchanged.

- [ ] **Step 6: Add generated artifact drift checker**

Create `scripts/check-generated-artifacts.ts`:

```ts
import { execFileSync } from "node:child_process";

const generatedPaths = [
  "packages/swift/Sources/FrickSwift/Generated/FrickGenerated.swift",
  "apps/android/frick/src/main/java/dev/frick/client/FrickGenerated.kt",
  "packages/protocol/fixtures",
];

execFileSync("pnpm", ["schema:generate"], { stdio: "inherit" });
execFileSync("pnpm", ["fixtures:generate"], { stdio: "inherit" });

try {
  execFileSync("git", ["diff", "--exit-code", "--", ...generatedPaths], { stdio: "inherit" });
} catch {
  console.error("Generated artifacts are out of date. Run pnpm schema:generate and pnpm fixtures:generate.");
  process.exit(1);
}
```

- [ ] **Step 7: Generate fixtures**

Run:

```bash
pnpm fixtures:generate
```

Expected: writes the three fixture JSON files.

- [ ] **Step 8: Run fixture and drift checks**

Run:

```bash
pnpm exec vitest run packages/protocol/tests/fixtures.test.ts
pnpm verify:generated
```

Expected: fixture tests pass. `pnpm verify:generated` passes after generated artifacts and fixture files are tracked.

- [ ] **Step 9: Commit**

```bash
git add packages/protocol/src/fixtures.ts packages/protocol/src/index.ts packages/protocol/scripts/generate-fixtures.ts packages/protocol/tests/fixtures.test.ts packages/protocol/fixtures/foundation-schema.json packages/protocol/fixtures/error-envelope.json packages/protocol/fixtures/hello-frame.json scripts/check-generated-artifacts.ts package.json
git commit -m "feat(protocol): add baseline fixtures and drift check"
```

## Task 9: Contract Baseline Verification

**Files:**
- No new files unless fixes are required by verification.

- [ ] **Step 1: Run focused protocol tests**

Run:

```bash
pnpm exec vitest run packages/protocol/tests/schema.test.ts packages/protocol/tests/compatibility.test.ts packages/protocol/tests/errors.test.ts packages/protocol/tests/capabilities.test.ts packages/protocol/tests/frame.test.ts packages/protocol/tests/artifacts.test.ts packages/protocol/tests/fixtures.test.ts
```

Expected: all selected protocol tests pass.

- [ ] **Step 2: Run server extension tests**

Run:

```bash
pnpm exec vitest run apps/server/tests/extensions.test.ts apps/server/tests/server.test.ts
```

Expected: server extension tests and existing server tests pass.

- [ ] **Step 3: Run full TypeScript verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm verify:generated
```

Expected: all pass.

- [ ] **Step 4: Run native metadata smoke checks**

Run:

```bash
pnpm swift:test
pnpm android:build
```

Expected: both pass in an environment with Xcode, Android SDK, and JDK 17 configured. If local native tooling is unavailable, record the exact missing tool error in the task handoff and keep the TypeScript/generated-artifact gate passing.

- [ ] **Step 5: Final review checklist**

Confirm:

- `docs/framework-boundaries.md` exists and distinguishes public/internal/demo/generated code.
- `FrickSchema` includes identity metadata.
- `compareSchemaCompatibility` is exported.
- `FrickErrorEnvelope` is exported and used by `NackPayload`.
- `HelloPayload` accepts `clientCapabilities`.
- Swift/Kotlin generated artifacts include schema id/version/revision/minimum revisions.
- Server extension registry skeleton exists and can be passed through server options.
- Baseline fixtures exist and are generated by script.
- `pnpm verify:generated` fails on drift and passes when artifacts are current.

- [ ] **Step 6: Commit verification fixes if needed**

If verification required fixes, commit them:

```bash
git add docs/framework-boundaries.md packages/protocol apps/server/src/extensions.ts apps/server/src/server.ts apps/server/tests/extensions.test.ts scripts/check-generated-artifacts.ts package.json packages/swift/Sources/FrickSwift/Generated/FrickGenerated.swift apps/android/frick/src/main/java/dev/frick/client/FrickGenerated.kt
git commit -m "fix: complete contract baseline verification"
```

If no fixes were required, do not create an empty commit.

## Self-Review Notes

Spec coverage:

- Public/internal/demo/generated boundary audit: Task 1.
- Schema metadata and compatibility: Tasks 2 and 3.
- Shared error envelope and request id shape: Task 4.
- Capability negotiation shape: Task 5.
- Generated native schema metadata: Task 6.
- Extension registry skeleton: Task 7.
- First fixture structure: Task 8.
- Generated artifact drift check: Task 8.
- Verification gate: Task 9.

Execution constraints:

- Keep generated files generated only.
- Keep `clientCapabilities` optional in this milestone to avoid forcing all SDK runtime changes before the client alignment slice.
- Do not implement production authz, migrations, app manifests, schema lint, or full CI in this milestone.
- Do not publish packages or create starter templates.
