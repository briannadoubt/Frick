export type FieldKind =
  | "id"
  | "ref"
  | "text"
  | "bool"
  | "timestamp"
  | "int";

export type ConflictPolicy = "lww" | "set" | "counter";

export interface FieldDef {
  id: number;
  name: string;
  kind: FieldKind;
  required: boolean;
  relation?: string;
  conflict?: ConflictPolicy;
  default?: unknown;
}

export interface IndexDef {
  id: number;
  name: string;
  fields: string[];
}

export interface EntityDef {
  id: number;
  name: string;
  fields: FieldDef[];
  indexes: IndexDef[];
}

export interface MutationDef {
  id: number;
  name: string;
  input: Record<string, FieldKind>;
}

export interface FrickManifest {
  name: string;
  protocolVersion: number;
  schemaVersion: number;
  hash: string;
  entities: EntityDef[];
  mutations: MutationDef[];
}

export type PlainObject = Record<string, unknown>;
export type PackedField = [fieldId: number, value: unknown];
export type PackedObject = [
  entityId: number,
  objectId: string,
  fields: PackedField[],
];
export type PackedPatch = [
  entityId: number,
  objectId: string,
  fields: PackedField[],
];

export interface ObjectDelta {
  seq: number;
  opId: string;
  mutation: string;
  entityId: number;
  entityName: string;
  objectId: string;
  fields: PackedField[];
}

export function entityByName(
  manifest: FrickManifest,
  entityName: string,
): EntityDef {
  const entity = manifest.entities.find((candidate) => candidate.name === entityName);
  if (!entity) {
    throw new Error(`Unknown entity: ${entityName}`);
  }
  return entity;
}

export function entityById(manifest: FrickManifest, entityId: number): EntityDef {
  const entity = manifest.entities.find((candidate) => candidate.id === entityId);
  if (!entity) {
    throw new Error(`Unknown entity id: ${entityId}`);
  }
  return entity;
}

export function fieldByName(entity: EntityDef, fieldName: string): FieldDef {
  const field = entity.fields.find((candidate) => candidate.name === fieldName);
  if (!field) {
    throw new Error(`Unknown field ${entity.name}.${fieldName}`);
  }
  return field;
}

export function fieldById(entity: EntityDef, fieldId: number): FieldDef {
  const field = entity.fields.find((candidate) => candidate.id === fieldId);
  if (!field) {
    throw new Error(`Unknown field ${entity.name}#${fieldId}`);
  }
  return field;
}

export function packObject(
  manifest: FrickManifest,
  entityName: string,
  object: PlainObject,
): PackedObject {
  const entity = entityByName(manifest, entityName);
  const id = object.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${entityName}.id must be a non-empty string`);
  }

  const fields = entity.fields
    .filter((field) => Object.prototype.hasOwnProperty.call(object, field.name))
    .map<PackedField>((field) => [field.id, object[field.name]]);

  return [entity.id, id, fields];
}

export function unpackObject(
  manifest: FrickManifest,
  packed: PackedObject,
): PlainObject {
  const [entityId, objectId, fields] = packed;
  const entity = entityById(manifest, entityId);
  const object: PlainObject = { id: objectId };

  for (const [fieldId, value] of fields) {
    const field = fieldById(entity, fieldId);
    object[field.name] = value;
  }

  return object;
}

export function packPatch(
  manifest: FrickManifest,
  entityName: string,
  objectId: string,
  patch: PlainObject,
): PackedPatch {
  const entity = entityByName(manifest, entityName);
  const fields = Object.entries(patch).map<PackedField>(([name, value]) => {
    const field = fieldByName(entity, name);
    return [field.id, value];
  });
  return [entity.id, objectId, fields];
}

export function unpackPatch(
  manifest: FrickManifest,
  packed: PackedPatch,
): { entityName: string; objectId: string; patch: PlainObject } {
  const [entityId, objectId, fields] = packed;
  const entity = entityById(manifest, entityId);
  const patch: PlainObject = {};

  for (const [fieldId, value] of fields) {
    const field = fieldById(entity, fieldId);
    patch[field.name] = value;
  }

  return { entityName: entity.name, objectId, patch };
}

export function applyPackedFields(
  manifest: FrickManifest,
  entityId: number,
  base: PlainObject,
  fields: PackedField[],
): PlainObject {
  const entity = entityById(manifest, entityId);
  const next = { ...base };
  for (const [fieldId, value] of fields) {
    const field = fieldById(entity, fieldId);
    next[field.name] = value;
  }
  return next;
}

export function indexByName(entity: EntityDef, indexName: string): IndexDef {
  const index = entity.indexes.find((candidate) => candidate.name === indexName);
  if (!index) {
    throw new Error(`Unknown index ${entity.name}.${indexName}`);
  }
  return index;
}
