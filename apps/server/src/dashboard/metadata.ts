import type { FrickSchema } from "@fricken/protocol";
import type { FrickAppRegistry } from "../apps/registry.js";
import type { PlatformEventHealth } from "../platform-events/types.js";
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
  readonly platformEvents?: PlatformEventHealth;
}

export interface BuildDashboardMetadataInput {
  readonly project: FrickProjectModule;
  readonly appRegistry: FrickAppRegistry;
  readonly platformEventsHealth?: PlatformEventHealth;
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
    ...(input.platformEventsHealth ? { platformEvents: input.platformEventsHealth } : {}),
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
