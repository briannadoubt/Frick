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
