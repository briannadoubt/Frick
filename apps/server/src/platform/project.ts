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
