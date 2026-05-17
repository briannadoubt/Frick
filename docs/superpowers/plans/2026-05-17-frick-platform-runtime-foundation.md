# Frick Platform Runtime Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the clean platform boundary for Frick as a self-hostable Firebase-like runtime, then mount the dashboard and schema metadata through that boundary.

**Architecture:** This plan deliberately avoids mixing event pipeline, OTel, product analytics, deployment generation, and dashboard mutations into one patch. It creates a project-module contract, routes the existing server through that contract, adds a focused dashboard API module, and mounts the dashboard as an authenticated server surface. Follow-up plans build the event pipeline, OTel, analytics, client tracking, and deployment on top of this seam.

**Tech Stack:** TypeScript, Node `http`, `node:fs/promises`, Vitest, existing Frick server/CLI/dashboard packages, existing `@frick/protocol` schema types.

---

## Scope and Guardrails

This is the first implementation slice for the broader design in `docs/superpowers/specs/2026-05-17-frick-platform-runtime-production-dashboard-design.md`.

Do this:

- Add a project module contract that app code can export.
- Let `createFrickServer` accept a project module without replacing the existing `schema` and `apps` options yet.
- Add a dashboard metadata API that derives resources from schema/runtime metadata.
- Mount the static dashboard app shell from the server under `/_frick/dashboard`.
- Authenticate every data-bearing dashboard API using the same production posture as inspection: production requires admin bearer; development can use admin bearer or session bearer. Static dashboard assets must contain no sensitive data and can be served without auth so browsers do not need bearer headers for document navigation.
- Keep all dashboard-specific logic outside `server.ts` except for a thin delegation call.

Do not do this in this plan:

- Do not add OpenTelemetry packages yet.
- Do not add SQLite or Redpanda/Kafka event-pipeline adapters yet.
- Do not add product analytics tables or SDK tracking yet.
- Do not create Docker Compose/Kubernetes profiles yet.
- Do not add dashboard data mutation actions yet.
- Do not move all server routing out of `server.ts`.
- Do not generate platform implementation into scaffolded apps.

Follow-up plans after this one:

1. `frick-event-pipeline-baseline`
2. `frick-otel-server-baseline`
3. `frick-product-analytics-baseline`
4. `frick-client-auto-tracking`
5. `frick-standard-dev-and-compose-stack`
6. `frick-dashboard-operator-actions`

## File Structure

Create:

- `apps/server/src/platform/project.ts`  
  Owns the project-module types and validation helpers.

- `apps/server/tests/platform-project.test.ts`  
  Tests contract validation without booting HTTP.

- `apps/server/src/dashboard/metadata.ts`  
  Pure builder that turns a project module, app registry, schema, jobs/search/projection metadata into dashboard JSON.

- `apps/server/src/dashboard/assets.ts`  
  Resolves and serves only known static dashboard files.

- `apps/server/src/dashboard/routes.ts`  
  Handles `/_frick/dashboard`, dashboard static assets, and authenticated `/_frick/dashboard/api/*`.

- `apps/server/tests/dashboard-routes.test.ts`  
  Boots a server and tests mounted dashboard behavior.

Modify:

- `apps/server/src/server.ts`  
  Add `project?: FrickProjectModuleInput | FrickProjectModule` to `ServerOptions`, derive a runtime project once, pass dashboard requests to `handleDashboardRoute(...)`, and use the project schema when no explicit `schema` or `apps` override is supplied.

- `apps/server/src/index.ts`  
  Export project-module types and helpers.

- `docs/operations.md`  
  Document mounted dashboard routes and auth.

- `docs/framework-boundaries.md`  
  Document that dashboard APIs are public operator surfaces while internal route helpers remain private.

- `CHANGELOG.md`  
  Add an unreleased note for mounted dashboard foundation.

## Public Shapes for This Slice

Use these names consistently across tasks:

```ts
export interface FrickProjectManifest {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly displayName?: string;
}

export interface FrickProjectModuleInput {
  readonly manifest: FrickProjectManifest;
  readonly schema: FrickSchema;
}

export interface FrickProjectModule {
  readonly manifest: FrickProjectManifest;
  readonly schema: FrickSchema;
}

export interface DashboardResourceSummary {
  readonly kind: "object" | "stream" | "event" | "presence" | "signal" | "blob" | "job" | "projection";
  readonly name: string;
  readonly fieldCount: number;
  readonly indexCount?: number;
}

export interface DashboardMetadata {
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly version?: string;
    readonly displayName?: string;
    readonly schemaId: string;
    readonly schemaVersion: string;
    readonly schemaRevision: number;
    readonly schemaHash: string;
  };
  readonly resources: readonly DashboardResourceSummary[];
  readonly apps: readonly {
    readonly id: string;
    readonly basePath: string;
    readonly schemaId: string;
    readonly schemaRevision: number;
  }[];
}
```

## Task 1: Project Module Contract

**Files:**

- Create: `apps/server/src/platform/project.ts`
- Create: `apps/server/tests/platform-project.test.ts`
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: Write the failing project contract tests**

Create `apps/server/tests/platform-project.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { foundationSchema } from "@frick/protocol";
import {
  createFrickProjectModule,
  projectModuleToAppDefinition,
} from "../src/platform/project.js";

describe("Frick project module contract", () => {
  it("normalizes a valid project module", () => {
    const project = createFrickProjectModule({
      manifest: {
        id: "crm",
        name: "crm",
        version: "0.1.0",
        displayName: "CRM",
      },
      schema: foundationSchema,
    });

    expect(project.manifest).toEqual({
      id: "crm",
      name: "crm",
      version: "0.1.0",
      displayName: "CRM",
    });
    expect(project.schema.schemaId).toBe(foundationSchema.schemaId);
  });

  it("rejects invalid project ids before the server boots", () => {
    expect(() =>
      createFrickProjectModule({
        manifest: { id: "Bad Project!", name: "bad" },
        schema: foundationSchema,
      }),
    ).toThrow(/manifest.id/);
  });

  it("validates the supplied schema", () => {
    expect(() =>
      createFrickProjectModule({
        manifest: { id: "broken", name: "broken" },
        schema: { ...foundationSchema, protocol: "nope" as "frick.realtime" },
      }),
    ).toThrow(/Unsupported protocol/);
  });

  it("can convert a project into the root app definition", () => {
    const project = createFrickProjectModule({
      manifest: { id: "crm", name: "crm" },
      schema: foundationSchema,
    });

    expect(projectModuleToAppDefinition(project)).toMatchObject({
      id: "crm",
      basePath: "",
      schema: foundationSchema,
    });
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
pnpm --filter @frick/server test -- tests/platform-project.test.ts
```

Expected: FAIL because `../src/platform/project.js` does not exist.

- [ ] **Step 3: Implement the project module contract**

Create `apps/server/src/platform/project.ts`:

```ts
import { validateSchema, type FrickSchema } from "@frick/protocol";
import type { FrickAppDefinition } from "../apps/registry.js";
import { FrickConfigError } from "../config.js";

export interface FrickProjectManifest {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly displayName?: string;
}

export interface FrickProjectModuleInput {
  readonly manifest: FrickProjectManifest;
  readonly schema: FrickSchema;
}

export interface FrickProjectModule {
  readonly manifest: FrickProjectManifest;
  readonly schema: FrickSchema;
}

const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;

export function createFrickProjectModule(input: FrickProjectModuleInput): FrickProjectModule {
  const manifest = normalizeManifest(input.manifest);
  const schema = validateSchema(input.schema);
  return { manifest, schema };
}

export function projectModuleToAppDefinition(project: FrickProjectModule): FrickAppDefinition {
  return {
    id: project.manifest.id,
    schema: project.schema,
    basePath: "",
  };
}

function normalizeManifest(manifest: FrickProjectManifest): FrickProjectManifest {
  const id = manifest.id.trim();
  if (!PROJECT_ID_PATTERN.test(id)) {
    throw new FrickConfigError(
      `project manifest.id must match ${PROJECT_ID_PATTERN.toString()} (got ${JSON.stringify(manifest.id)})`,
    );
  }

  const name = manifest.name.trim();
  if (name.length === 0 || name.length > 80) {
    throw new FrickConfigError("project manifest.name must be between 1 and 80 characters");
  }

  const version = manifest.version?.trim();
  if (version !== undefined && version.length === 0) {
    throw new FrickConfigError("project manifest.version cannot be empty when provided");
  }

  const displayName = manifest.displayName?.trim();
  if (displayName !== undefined && (displayName.length === 0 || displayName.length > 120)) {
    throw new FrickConfigError("project manifest.displayName must be between 1 and 120 characters when provided");
  }

  return {
    id,
    name,
    ...(version ? { version } : {}),
    ...(displayName ? { displayName } : {}),
  };
}
```

- [ ] **Step 4: Export the contract**

Modify `apps/server/src/index.ts` to add:

```ts
export {
  createFrickProjectModule,
  projectModuleToAppDefinition,
  type FrickProjectManifest,
  type FrickProjectModule,
  type FrickProjectModuleInput,
} from "./platform/project.js";
```

- [ ] **Step 5: Run the project contract tests**

Run:

```bash
pnpm --filter @frick/server test -- tests/platform-project.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/platform/project.ts apps/server/tests/platform-project.test.ts apps/server/src/index.ts
git commit -m "feat(server): add frick project module contract"
```

## Task 2: Server Uses Project Module Without Replacing Existing Options

**Files:**

- Modify: `apps/server/src/server.ts`
- Test: `apps/server/tests/dashboard-routes.test.ts`

- [ ] **Step 1: Write failing server project tests**

Create `apps/server/tests/dashboard-routes.test.ts` with this first test group:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { foundationSchema, type FrickSchema } from "@frick/protocol";
import {
  createFrickProjectModule,
  createFrickServer,
} from "../src/index.js";

let app: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("platform project runtime", () => {
  it("uses the project schema as the root app schema", async () => {
    const schema: FrickSchema = {
      ...foundationSchema,
      name: "crm",
      schemaId: "crm",
      schemaVersion: "0.1.0",
      hash: "crm-hash",
    };
    const project = createFrickProjectModule({
      manifest: { id: "crm", name: "crm", displayName: "CRM" },
      schema,
    });

    app = await startServer({ project });

    const schemaResponse = await fetch(`${app.httpUrl}/schema`);
    expect(schemaResponse.status).toBe(200);
    const schemaBody = await schemaResponse.json();
    expect(schemaBody.schemaId).toBe("crm");

    const inspectResponse = await fetch(`${app.httpUrl}/_frick/inspect/apps`, {
      headers: await inspectHeaders(app.httpUrl),
    });
    expect(inspectResponse.status).toBe(200);
    const inspectBody = await inspectResponse.json();
    expect(inspectBody.apps).toEqual([
      {
        id: "crm",
        basePath: "",
        schemaId: "crm",
        schemaRevision: foundationSchema.schemaRevision,
      },
    ]);
  });

  it("lets explicit schema override project schema for backwards compatibility", async () => {
    const projectSchema: FrickSchema = {
      ...foundationSchema,
      name: "project-schema",
      schemaId: "project-schema",
      hash: "project-schema-hash",
    };
    const explicitSchema: FrickSchema = {
      ...foundationSchema,
      name: "explicit-schema",
      schemaId: "explicit-schema",
      hash: "explicit-schema-hash",
    };

    app = await startServer({
      project: createFrickProjectModule({
        manifest: { id: "crm", name: "crm" },
        schema: projectSchema,
      }),
      schema: explicitSchema,
    });

    const response = await fetch(`${app.httpUrl}/schema`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.schemaId).toBe("explicit-schema");
  });
});

async function startServer(options: Parameters<typeof createFrickServer>[0] = {}) {
  const server = createFrickServer({
    port: 0,
    dbPath: ":memory:",
    ...options,
  });
  await server.listen();
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server address");
  }
  return {
    httpUrl: `http://127.0.0.1:${address.port}`,
    close: server.close,
  };
}

async function inspectHeaders(httpUrl: string): Promise<Record<string, string>> {
  const response = await fetch(`${httpUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "user-ada" }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { sessionToken: string };
  return { authorization: `Bearer ${body.sessionToken}` };
}
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
pnpm --filter @frick/server test -- tests/dashboard-routes.test.ts
```

Expected: FAIL because `ServerOptions` has no `project` property and the server still synthesizes the `"foundation"` app.

- [ ] **Step 3: Add `project` to `ServerOptions` and derive schema once**

Modify imports in `apps/server/src/server.ts`:

```ts
import {
  createFrickProjectModule,
  projectModuleToAppDefinition,
  type FrickProjectModule,
  type FrickProjectModuleInput,
} from "./platform/project.js";
```

Add to `ServerOptions` near `schema?: FrickSchema`:

```ts
  /**
   * Project module loaded by the platform runtime. This is the preferred
   * Firebase-like app boundary: project code supplies schema and metadata,
   * while Frick owns the runtime. Existing `schema` and `apps` options remain
   * supported and take precedence for backwards compatibility.
   */
  project?: FrickProjectModule | FrickProjectModuleInput;
```

At the top of `createFrickServer`, after `authAttemptLimiter`, add:

```ts
  const project = options.project ? createFrickProjectModule(options.project) : undefined;
  const runtimeSchema = options.schema ?? project?.schema ?? foundationSchema;
```

Replace the store schema line:

```ts
    schema: options.schema ?? foundationSchema,
```

with:

```ts
    schema: runtimeSchema,
```

Replace the app registry default:

```ts
    options.apps ?? [
      { id: "foundation", schema: store.schema, basePath: "" },
    ],
```

with:

```ts
    options.apps ?? [
      project && options.schema === undefined
        ? projectModuleToAppDefinition(project)
        : { id: "foundation", schema: store.schema, basePath: "" },
    ],
```

If TypeScript complains that the conditional array element can be `false` or `undefined`, use this exact local before creating the registry:

```ts
  const defaultApp: FrickAppDefinition =
    project && options.schema === undefined
      ? projectModuleToAppDefinition(project)
      : { id: "foundation", schema: store.schema, basePath: "" };
```

and then:

```ts
  const appRegistry: FrickAppRegistry = createFrickAppRegistry(
    options.apps ?? [defaultApp],
  );
```

- [ ] **Step 4: Run the dashboard route tests**

Run:

```bash
pnpm --filter @frick/server test -- tests/dashboard-routes.test.ts
```

Expected: PASS for the two project runtime tests.

- [ ] **Step 5: Run existing operational tests**

Run:

```bash
pnpm --filter @frick/server test -- tests/ops-endpoints.test.ts
```

Expected: PASS. This confirms existing inspect behavior did not regress.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/server.ts apps/server/tests/dashboard-routes.test.ts
git commit -m "feat(server): load project modules in runtime"
```

## Task 3: Pure Dashboard Metadata Builder

**Files:**

- Create: `apps/server/src/dashboard/metadata.ts`
- Create: `apps/server/tests/dashboard-metadata.test.ts`

- [ ] **Step 1: Write failing metadata tests**

Create `apps/server/tests/dashboard-metadata.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { foundationSchema } from "@frick/protocol";
import { createFrickAppRegistry } from "../src/apps/registry.js";
import { buildDashboardMetadata } from "../src/dashboard/metadata.js";
import { createFrickProjectModule } from "../src/platform/project.js";

describe("dashboard metadata", () => {
  it("summarizes project identity and schema resources", () => {
    const project = createFrickProjectModule({
      manifest: { id: "foundation", name: "foundation", displayName: "Foundation" },
      schema: foundationSchema,
    });
    const appRegistry = createFrickAppRegistry([
      { id: "foundation", basePath: "", schema: foundationSchema },
    ]);

    const metadata = buildDashboardMetadata({ project, appRegistry });

    expect(metadata.project).toMatchObject({
      id: "foundation",
      name: "foundation",
      displayName: "Foundation",
      schemaId: foundationSchema.schemaId,
      schemaVersion: foundationSchema.schemaVersion,
      schemaRevision: foundationSchema.schemaRevision,
      schemaHash: foundationSchema.hash,
    });
    expect(metadata.resources).toContainEqual({
      kind: "object",
      name: "User",
      fieldCount: 2,
      indexCount: 1,
    });
    expect(metadata.resources).toContainEqual({
      kind: "stream",
      name: "MessageStream",
      fieldCount: 1,
    });
    expect(metadata.apps).toEqual([
      {
        id: "foundation",
        basePath: "",
        schemaId: foundationSchema.schemaId,
        schemaRevision: foundationSchema.schemaRevision,
      },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
pnpm --filter @frick/server test -- tests/dashboard-metadata.test.ts
```

Expected: FAIL because `../src/dashboard/metadata.js` does not exist.

- [ ] **Step 3: Implement the metadata builder**

Create `apps/server/src/dashboard/metadata.ts`:

```ts
import type { FrickSchema } from "@frick/protocol";
import type { FrickAppRegistry } from "../apps/registry.js";
import type { FrickProjectModule } from "../platform/project.js";

export interface DashboardResourceSummary {
  readonly kind: "object" | "stream" | "event" | "presence" | "signal" | "blob" | "job" | "projection";
  readonly name: string;
  readonly fieldCount: number;
  readonly indexCount?: number;
}

export interface DashboardMetadata {
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly version?: string;
    readonly displayName?: string;
    readonly schemaId: string;
    readonly schemaVersion: string;
    readonly schemaRevision: number;
    readonly schemaHash: string;
  };
  readonly resources: readonly DashboardResourceSummary[];
  readonly apps: readonly {
    readonly id: string;
    readonly basePath: string;
    readonly schemaId: string;
    readonly schemaRevision: number;
  }[];
}

export interface BuildDashboardMetadataInput {
  readonly project: FrickProjectModule;
  readonly appRegistry: FrickAppRegistry;
}

export function buildDashboardMetadata(input: BuildDashboardMetadataInput): DashboardMetadata {
  const { project, appRegistry } = input;
  const schema = project.schema;
  return {
    project: {
      id: project.manifest.id,
      name: project.manifest.name,
      ...(project.manifest.version ? { version: project.manifest.version } : {}),
      ...(project.manifest.displayName ? { displayName: project.manifest.displayName } : {}),
      schemaId: schema.schemaId,
      schemaVersion: schema.schemaVersion,
      schemaRevision: schema.schemaRevision,
      schemaHash: schema.hash,
    },
    resources: resourceSummaries(schema),
    apps: appRegistry.list().map((app) => ({
      id: app.id,
      basePath: app.basePath,
      schemaId: app.schema.schemaId,
      schemaRevision: app.schema.schemaRevision,
    })),
  };
}

function resourceSummaries(schema: FrickSchema): DashboardResourceSummary[] {
  return [
    ...schema.objects.map((object) => ({
      kind: "object" as const,
      name: object.name,
      fieldCount: object.fields.length,
      indexCount: object.indexes.length,
    })),
    ...schema.streams.map((stream) => ({
      kind: "stream" as const,
      name: stream.name,
      fieldCount: stream.keyFields.length,
    })),
    ...schema.events.map((event) => ({
      kind: "event" as const,
      name: event.name,
      fieldCount: event.fields.length,
    })),
    ...schema.presences.map((presence) => ({
      kind: "presence" as const,
      name: presence.name,
      fieldCount: presence.fields.length + presence.keyFields.length,
    })),
    ...schema.signals.map((signal) => ({
      kind: "signal" as const,
      name: signal.name,
      fieldCount: signal.fields.length + signal.keyFields.length,
    })),
    ...schema.blobs.map((blob) => ({
      kind: "blob" as const,
      name: blob.name,
      fieldCount: blob.metadataFields.length,
    })),
    ...schema.jobs.map((job) => ({
      kind: "job" as const,
      name: job.name,
      fieldCount: job.fields.length,
    })),
    ...schema.projections.map((projection) => ({
      kind: "projection" as const,
      name: projection.name,
      fieldCount: projection.fields.length,
      indexCount: projection.indexes.length,
    })),
  ];
}
```

- [ ] **Step 4: Run metadata tests**

Run:

```bash
pnpm --filter @frick/server test -- tests/dashboard-metadata.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/dashboard/metadata.ts apps/server/tests/dashboard-metadata.test.ts
git commit -m "feat(server): derive dashboard metadata from project schema"
```

## Task 4: Mounted Dashboard Assets and Metadata Routes

**Files:**

- Create: `apps/server/src/dashboard/assets.ts`
- Create: `apps/server/src/dashboard/routes.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/tests/dashboard-routes.test.ts`

- [ ] **Step 1: Add failing mounted dashboard tests**

Append to `apps/server/tests/dashboard-routes.test.ts`:

```ts
describe("mounted dashboard", () => {
  it("serves dashboard HTML without embedding sensitive data", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/dashboard`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Fricken Dashboard");
    expect(html).toContain('href="dashboard.css"');
    expect(html).toContain('src="dashboard.js"');
    expect(html).not.toContain("sessionToken");
    expect(html).not.toContain("adminToken");
  });

  it("requires authentication for dashboard metadata", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/dashboard/api/metadata`);

    expect(response.status).toBe(401);
  });

  it("serves dashboard metadata API when authenticated", async () => {
    app = await startServer();
    const response = await fetch(`${app.httpUrl}/_frick/dashboard/api/metadata`, {
      headers: await inspectHeaders(app.httpUrl),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.project.schemaId).toBe("frick-foundation");
    expect(body.resources).toContainEqual({
      kind: "object",
      name: "User",
      fieldCount: 2,
      indexCount: 1,
    });
  });

  it("requires production admin bearer for dashboard metadata in production", async () => {
    const adminToken = "test-admin-token-1234567890ABCDEF1234567890ABCDEF";
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "frick-dashboard-prod-"));
    const dbPath = path.join(dir, "frick.sqlite");
    try {
      app = await startServer({
        dbPath,
        config: {
          env: "production",
          dbPath,
          demoAuthEnabled: false,
          inspectionEnabled: false,
          adminToken,
        },
      });

      const shell = await fetch(`${app.httpUrl}/_frick/dashboard`);
      expect(shell.status).toBe(200);

      const denied = await fetch(`${app.httpUrl}/_frick/dashboard/api/metadata`);
      expect(denied.status).toBe(401);

      const allowed = await fetch(`${app.httpUrl}/_frick/dashboard/api/metadata`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(allowed.status).toBe(200);
    } finally {
      await app?.close();
      app = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
pnpm --filter @frick/server test -- tests/dashboard-routes.test.ts
```

Expected: FAIL because `/_frick/dashboard` returns 404.

- [ ] **Step 3: Implement static asset serving**

Create `apps/server/src/dashboard/assets.ts`:

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { access, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const allowedFiles = new Map([
  ["", "index.html"],
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/dashboard.css", "dashboard.css"],
  ["/dashboard.js", "dashboard.js"],
]);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
} as const;

export async function resolveDashboardAssetRoot(here = dirname(fileURLToPath(import.meta.url))): Promise<string> {
  const candidates = [
    resolve(here, "../dev-dashboard"),
    resolve(here, "../../dev-dashboard"),
    resolve(here, "../../../dev-dashboard"),
  ];

  for (const candidate of candidates) {
    try {
      await access(resolve(candidate, "index.html"));
      return candidate;
    } catch {
      // Try the next packaged/source layout.
    }
  }

  throw new Error("dashboard assets were not found");
}

export async function sendDashboardAsset(
  input: {
    request: IncomingMessage;
    response: ServerResponse;
    assetRoot: string;
    path: string;
    headers: Record<string, string>;
  },
): Promise<boolean> {
  const fileName = allowedFiles.get(input.path);
  if (!fileName) return false;
  const file = resolve(input.assetRoot, fileName);
  const body = await readFile(file);
  input.response.writeHead(200, {
    ...input.headers,
    "content-type": mime[extname(file) as keyof typeof mime] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  input.response.end(input.request.method === "HEAD" ? undefined : body);
  return true;
}
```

- [ ] **Step 4: Implement dashboard route module**

Create `apps/server/src/dashboard/routes.ts`:

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { AuthenticationError, type Principal } from "../authz.js";
import type { FrickAppRegistry } from "../apps/registry.js";
import type { FrickConfig } from "../config.js";
import type { FrickStore } from "../store.js";
import type { FrickProjectModule } from "../platform/project.js";
import { buildDashboardMetadata } from "./metadata.js";
import { resolveDashboardAssetRoot, sendDashboardAsset } from "./assets.js";

export interface DashboardRouteInput {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly config: FrickConfig;
  readonly store: FrickStore;
  readonly project: FrickProjectModule;
  readonly appRegistry: FrickAppRegistry;
  readonly authenticate: () => Principal | AuthenticationError;
  readonly sendJson: (status: number, body: unknown) => void;
  readonly sendError: (error: unknown, requestId: string) => void;
}

const securityHeaders = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "script-src-attr 'none'",
    "style-src 'self'",
    "style-src-attr 'none'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

export async function handleDashboardRoute(input: DashboardRouteInput): Promise<boolean> {
  if (!input.url.pathname.startsWith("/_frick/dashboard")) return false;

  if (input.request.method !== "GET" && input.request.method !== "HEAD") {
    input.response.writeHead(405, {
      ...securityHeaders,
      allow: "GET, HEAD",
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    input.response.end("method not allowed");
    return true;
  }

  const relativePath = input.url.pathname.slice("/_frick/dashboard".length);
  if (relativePath === "") {
    input.response.writeHead(302, {
      location: "/_frick/dashboard/",
      "cache-control": "no-store",
    });
    input.response.end();
    return true;
  }

  if (relativePath === "/api/metadata") {
    const principal = input.authenticate();
    if (principal instanceof Error) {
      input.sendError(principal, "dashboard_unauthorized");
      return true;
    }
    void principal;
    input.sendJson(200, buildDashboardMetadata({
      project: input.project,
      appRegistry: input.appRegistry,
    }));
    return true;
  }

  const assetRoot = await resolveDashboardAssetRoot();
  const sent = await sendDashboardAsset({
    request: input.request,
    response: input.response,
    assetRoot,
    path: relativePath,
    headers: securityHeaders,
  });
  if (sent) return true;

  input.sendJson(404, { error: "not_found" });
  return true;
}
```

- [ ] **Step 5: Delegate dashboard routes from `server.ts`**

Add imports to `apps/server/src/server.ts`:

```ts
import { handleDashboardRoute } from "./dashboard/routes.js";
```

After `appRegistry` is created, create an effective project when none was supplied:

```ts
  const runtimeProject =
    project ??
    createFrickProjectModule({
      manifest: {
        id: defaultApp.id,
        name: defaultApp.id,
        displayName: defaultApp.id === "foundation" ? "Frick Foundation" : defaultApp.id,
      },
      schema: store.schema,
    });
```

Inside `dispatchHttp`, after the `OPTIONS` block and before `/health`, add:

```ts
    if (
      await handleDashboardRoute({
        request,
        response,
        url,
        config,
        store,
        project: runtimeProject,
        appRegistry,
        authenticate: () => inspectionPrincipalFromRequest(request, url, store, config),
        sendJson: (status, body) => sendJson(response, status, body),
        sendError: (error, requestId) => sendErrorWithMetrics(response, error, requestId),
      })
    ) {
      return;
    }
```

This is the only dashboard route logic that belongs in `server.ts`.

- [ ] **Step 6: Make dashboard asset references mount-safe**

Modify `apps/dev-dashboard/index.html`:

```html
<link rel="stylesheet" href="dashboard.css" />
```

and:

```html
<script src="dashboard.js"></script>
```

The absence of a leading slash lets the same static app work at standalone `/`
and mounted `/_frick/dashboard/`.

- [ ] **Step 7: Run HTML parse smoke**

Run:

```bash
node --check apps/dev-dashboard/dashboard.js
```

Expected: no output and exit 0.

- [ ] **Step 8: Run mounted dashboard tests**

Run:

```bash
pnpm --filter @frick/server test -- tests/dashboard-routes.test.ts
```

Expected: PASS.

- [ ] **Step 9: Run relevant server tests**

Run:

```bash
pnpm --filter @frick/server test -- tests/ops-endpoints.test.ts tests/admin-routes.test.ts tests/dashboard-routes.test.ts tests/dashboard-metadata.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/dashboard/assets.ts apps/server/src/dashboard/routes.ts apps/server/src/server.ts apps/server/tests/dashboard-routes.test.ts apps/dev-dashboard/index.html
git commit -m "feat(server): mount authenticated frick dashboard"
```

## Task 5: Dashboard UI Reads Mounted Metadata

**Files:**

- Modify: `apps/dev-dashboard/dashboard.js`
- Test: `apps/server/tests/dashboard-routes.test.ts`

- [ ] **Step 1: Add a failing static asset assertion**

Append to the mounted dashboard metadata test in `apps/server/tests/dashboard-routes.test.ts`:

```ts
    const scriptResponse = await fetch(`${app.httpUrl}/_frick/dashboard/dashboard.js`, {
      headers: await inspectHeaders(app.httpUrl),
    });
    expect(scriptResponse.status).toBe(200);
    expect(await scriptResponse.text()).toContain("/_frick/dashboard/api/metadata");
```

Run:

```bash
pnpm --filter @frick/server test -- tests/dashboard-routes.test.ts
```

Expected: FAIL because the current dashboard script does not fetch mounted metadata.

- [ ] **Step 2: Add mounted metadata fetch to the dashboard script**

In `apps/dev-dashboard/dashboard.js`, add a fetcher next to the existing inspection fetchers:

```js
async function fetchDashboardMetadata() {
  if (!location.pathname.startsWith("/_frick/dashboard")) return undefined;
  return fetchJson("/_frick/dashboard/api/metadata", { auth: true });
}
```

At the top of `apps/dev-dashboard/dashboard.js`, replace:

```js
const DEFAULT_ENDPOINT = "http://127.0.0.1:4099";
```

with:

```js
const DEFAULT_ENDPOINT = isMountedDashboard() ? location.origin : "http://127.0.0.1:4099";

function isMountedDashboard() {
  return location.pathname === "/_frick/dashboard" || location.pathname.startsWith("/_frick/dashboard/");
}
```

In `refreshData()`, include:

```js
    dashboardMetadata: () => fetchDashboardMetadata(),
```

When assigning successful results, skip `undefined` metadata:

```js
      if (key === "dashboardMetadata" && value === undefined) continue;
```

In `inspectionSummary()`, include project metadata when present:

```js
  if (state.data.dashboardMetadata) {
    summary.project = state.data.dashboardMetadata.project;
    summary.resources = state.data.dashboardMetadata.resources?.length ?? 0;
  }
```

The exact insertion points should keep the file’s existing plain-JS style. Do not introduce a bundler or framework in this task.

- [ ] **Step 3: Run JS parse check**

Run:

```bash
node --check apps/dev-dashboard/dashboard.js
```

Expected: no output and exit 0.

- [ ] **Step 4: Run dashboard route tests**

Run:

```bash
pnpm --filter @frick/server test -- tests/dashboard-routes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dev-dashboard/dashboard.js apps/server/tests/dashboard-routes.test.ts
git commit -m "feat(dashboard): read mounted project metadata"
```

## Task 6: Documentation and Boundary Notes

**Files:**

- Modify: `docs/operations.md`
- Modify: `docs/framework-boundaries.md`
- Modify: `docs/status.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update operations docs**

In `docs/operations.md`, add this paragraph after the local dashboard paragraph in the inspection/dashboard section:

```md
For production deployments, the Frick server can mount Fricken Dashboard at
`/_frick/dashboard`. Mounted mode is the preferred production shape because the
dashboard shares the server origin and security headers. Static dashboard
assets contain no sensitive data and may be served without auth; data-bearing
dashboard APIs under `/_frick/dashboard/api/*` require auth. In production,
those APIs require the configured admin bearer until the dashboard capability
system lands. In development, a valid session bearer from `/auth/dev-login` can
read the dashboard APIs.
```

- [ ] **Step 2: Update framework boundaries**

In `docs/framework-boundaries.md`, add under public server surfaces:

```md
- Mounted dashboard routes under `/_frick/dashboard` and documented
  `/_frick/dashboard/api/*` responses are operator-facing surfaces. Internal
  route helper modules under `apps/server/src/dashboard/*` remain private
  implementation unless exported from `apps/server/src/index.ts`.
```

- [ ] **Step 3: Update status**

In `docs/status.md`, change the dashboard bullet to mention mounted mode:

```md
- Fricken Dashboard, served locally by `frick dashboard` and mountable at
  `/_frick/dashboard`, for inspecting health, readiness, schema identity,
  schema resources, metrics, jobs, migrations, and DevTools events against a
  running server.
```

- [ ] **Step 4: Update changelog**

In `CHANGELOG.md` under `Unreleased`, add:

```md
- Added the first Frick Platform runtime boundary: project modules can supply
  schema/manifest metadata, and the server can mount authenticated Fricken
  Dashboard routes plus project/schema metadata at `/_frick/dashboard`.
```

- [ ] **Step 5: Run docs grep check**

Run:

```bash
rg -n "frick dashboard|/_frick/dashboard|project module|Fricken Dashboard" docs README.md CHANGELOG.md apps/cli/README.md
```

Expected: output includes the new mounted dashboard docs and no stale claim that the dashboard is local-only.

- [ ] **Step 6: Commit**

```bash
git add docs/operations.md docs/framework-boundaries.md docs/status.md CHANGELOG.md
git commit -m "docs: document mounted frick dashboard foundation"
```

## Task 7: Final Verification

**Files:** no new files unless verification reveals a defect.

- [ ] **Step 1: Run focused server tests**

```bash
pnpm --filter @frick/server test -- tests/platform-project.test.ts tests/dashboard-metadata.test.ts tests/dashboard-routes.test.ts tests/ops-endpoints.test.ts tests/admin-routes.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run dashboard JS parse check**

```bash
node --check apps/dev-dashboard/dashboard.js
```

Expected: PASS with no output.

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Run full tests**

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 5: Check formatting hazards**

```bash
git diff --check
```

Expected: PASS with no output.

- [ ] **Step 6: Final review of touched code boundaries**

Run:

```bash
git diff --stat HEAD~6..HEAD
git diff --name-only HEAD~6..HEAD
```

Expected:

- `server.ts` changed only for option wiring and dashboard delegation.
- Dashboard route logic lives in `apps/server/src/dashboard/*`.
- Project module logic lives in `apps/server/src/platform/project.ts`.
- No OTel, analytics, or deployment code appears in this slice.
- No SQLite event-pipeline, Redpanda/Kafka, OTel, analytics, or deployment code appears in this slice.

- [ ] **Step 7: Commit any final fixes**

If verification required fixes:

```bash
git add <fixed-files>
git commit -m "fix: stabilize platform runtime foundation"
```

If no fixes were required, do not create an empty commit.
