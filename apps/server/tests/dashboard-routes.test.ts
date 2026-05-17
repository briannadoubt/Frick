import { afterEach, describe, expect, it } from "vitest";
import { foundationSchema, type FrickSchema } from "@frick/protocol";
import { createFrickServer } from "../src/server.js";
import { createFrickProjectModule } from "../src/platform/project.js";

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

  it("does not use project schema as the shared runtime schema when apps are explicit", async () => {
    const projectSchema: FrickSchema = {
      ...foundationSchema,
      name: "project-schema",
      schemaId: "project-schema",
      hash: "project-schema-hash",
    };
    const appSchema: FrickSchema = {
      ...foundationSchema,
      name: "explicit-app",
      schemaId: "explicit-app",
      hash: "explicit-app-hash",
    };

    app = await startServer({
      project: createFrickProjectModule({
        manifest: { id: "crm", name: "crm" },
        schema: projectSchema,
      }),
      apps: [{ id: "explicit-app", basePath: "", schema: appSchema }],
    });

    const schemaResponse = await fetch(`${app.httpUrl}/schema`);
    expect(schemaResponse.status).toBe(200);
    expect((await schemaResponse.json()).schemaId).toBe("explicit-app");

    const readyResponse = await fetch(`${app.httpUrl}/ready`);
    expect(readyResponse.status).toBe(200);
    expect((await readyResponse.json()).schemaId).toBe(foundationSchema.schemaId);
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
