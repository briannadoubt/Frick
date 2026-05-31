export type FieldKind =
  | "id"
  | "ref"
  | "string"
  | "bool"
  | "timestamp"
  | "int"
  | "bytes"
  | "enum"
  | "json";

/**
 * Sensitivity classification for a field's values. Informs how the framework
 * treats the field in logs, diagnostics, admin inspection, and (future) data
 * export / deletion / audit workflows.
 *
 *  - "public": safe for normal app reads and logs when otherwise authorized.
 *  - "private" (default when omitted): authorized app reads only; never
 *    surfaced in broad inspection or diagnostics output.
 *  - "pii": personal data that participates in export / deletion / privacy
 *    workflows; masked in logs and diagnostics.
 *  - "secret": credentials or tokens; never logged, exported casually, or
 *    shown in diagnostics. Always masked.
 *  - "content": user-generated message / file content; privacy-safe logs and
 *    inspection avoid raw values.
 */
export type FieldSensitivity = "public" | "private" | "pii" | "secret" | "content";

/**
 * Default classification applied to fields that omit {@link FieldDef.sensitivity}.
 *
 * We default to "private" rather than "public" so that an un-annotated field is
 * treated conservatively (authorized reads only, kept out of broad inspection
 * output). This keeps existing schemas — which carry no `sensitivity` — safe by
 * default while remaining fully backward-compatible: nothing changes on the
 * wire, and authoring a field as "public" is an explicit opt-in.
 */
export const DEFAULT_FIELD_SENSITIVITY: FieldSensitivity = "private";

export interface FieldDef {
  id: number;
  name: string;
  kind: FieldKind;
  required: boolean;
  ref?: string;
  enumValues?: string[];
  /**
   * Optional sensitivity classification. When omitted the framework treats the
   * field as {@link DEFAULT_FIELD_SENSITIVITY}. Server-only metadata: it is not
   * propagated to generated native artifacts (Swift / Kotlin / TS bindings),
   * so adding or changing it never requires regenerating those outputs and is
   * wire-backwards-compatible. See {@link FieldSensitivity}.
   */
  sensitivity?: FieldSensitivity;
}

const FIELD_SENSITIVITY_VALUES: ReadonlySet<string> = new Set<FieldSensitivity>([
  "public",
  "private",
  "pii",
  "secret",
  "content",
]);

/**
 * Resolve the effective sensitivity for a field, falling back to
 * {@link DEFAULT_FIELD_SENSITIVITY} when the annotation is omitted.
 */
export function resolveFieldSensitivity(field: Pick<FieldDef, "sensitivity">): FieldSensitivity {
  return field.sensitivity ?? DEFAULT_FIELD_SENSITIVITY;
}

export interface IndexDef {
  id: number;
  name: string;
  fields: string[];
}

/**
 * How conflicting writes to the same object are resolved on the server.
 *
 *  - "lastWriteWins" (default when omitted): every {@link upsertObject} call
 *    clobbers the row unconditionally. This preserves the framework's
 *    historical behavior and is the right policy for objects whose state is
 *    derived from a single authoritative writer.
 *  - "versionPrecondition": writes must declare the version they expect to
 *    see and the server rejects the write (HTTP 409 / storage.conflict) if
 *    the on-disk version disagrees. Use for objects mutated by multiple
 *    independent writers.
 *
 * NOTE: This field is *server-only* for v1. The generated native artifacts
 * (Swift / Kotlin) intentionally do not emit `mergePolicy` — adding it later
 * is wire-backwards-compatible because it is optional and existing clients
 * never read it. The artifact generator therefore does not need to be
 * regenerated when this field is added or changed.
 */
export type FrickObjectMergePolicy = "lastWriteWins" | "versionPrecondition";

export interface ObjectDef {
  id: number;
  name: string;
  fields: FieldDef[];
  indexes: IndexDef[];
  /**
   * Optional conflict-resolution policy. When omitted, the framework treats
   * the object as "lastWriteWins" (the historical behavior). Not propagated
   * to generated artifacts — see {@link FrickObjectMergePolicy}.
   */
  mergePolicy?: FrickObjectMergePolicy;
}

export interface StreamDef {
  id: number;
  name: string;
  keyFields: FieldDef[];
  events: string[];
}

export interface EventDef {
  id: number;
  name: string;
  fields: FieldDef[];
}

export interface PresenceDef {
  id: number;
  name: string;
  keyFields: FieldDef[];
  fields: FieldDef[];
  ttlMs: number;
}

export interface SignalDef {
  id: number;
  name: string;
  keyFields: FieldDef[];
  fields: FieldDef[];
  ttlMs: number;
}

export interface BlobDef {
  id: number;
  name: string;
  metadataFields: FieldDef[];
}

export interface JobDef {
  id: number;
  name: string;
  fields: FieldDef[];
}

export interface ProjectionDef {
  id: number;
  name: string;
  source: string;
  fields: FieldDef[];
  indexes: IndexDef[];
}

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

export type PlainObject = Record<string, unknown>;
export type PackedField = [fieldId: number, value: unknown];
export type PackedRecord = [typeId: number, recordId: string, fields: PackedField[]];

export function validateSchema(schema: FrickSchema): FrickSchema {
  const normalized = stableClone(schema) as FrickSchema;

  if (normalized.protocol !== "frick.realtime") {
    throw new Error(`Unsupported protocol: ${String(normalized.protocol)}`);
  }
  if (normalized.compatibility !== "greenfield-cutover") {
    throw new Error(`Unsupported compatibility mode: ${String(normalized.compatibility)}`);
  }
  validateSchemaIdentity(normalized);

  validateTypeSet(normalized.objects, "object");
  validateTypeSet(normalized.streams, "stream");
  validateTypeSet(normalized.events, "event");
  validateTypeSet(normalized.presences, "presence");
  validateTypeSet(normalized.signals, "signal");
  validateTypeSet(normalized.blobs, "blob");
  validateTypeSet(normalized.jobs, "job");
  validateTypeSet(normalized.projections, "projection");

  const objectNames = new Set(normalized.objects.map((type) => type.name));
  const eventNames = new Set(normalized.events.map((type) => type.name));
  const streamNames = new Set(normalized.streams.map((type) => type.name));
  const blobNames = new Set(normalized.blobs.map((type) => type.name));

  for (const object of normalized.objects) {
    validateFields(`${object.name}`, object.fields, { objectNames, blobNames });
    validateIndexes(object.name, object.fields, object.indexes);
  }

  for (const stream of normalized.streams) {
    validateFields(`${stream.name}.key`, stream.keyFields, { objectNames, blobNames });
    for (const event of stream.events) {
      if (!eventNames.has(event)) {
        throw new Error(`Unknown stream event ${event} in ${stream.name}`);
      }
    }
  }

  for (const event of normalized.events) {
    validateFields(event.name, event.fields, { objectNames, blobNames });
  }

  for (const presence of normalized.presences) {
    validateFields(`${presence.name}.key`, presence.keyFields, { objectNames, blobNames });
    validateFields(presence.name, presence.fields, { objectNames, blobNames });
  }

  for (const signal of normalized.signals) {
    validateFields(`${signal.name}.key`, signal.keyFields, { objectNames, blobNames });
    validateFields(signal.name, signal.fields, { objectNames, blobNames });
  }

  for (const blob of normalized.blobs) {
    validateFields(blob.name, blob.metadataFields, { objectNames, blobNames });
  }

  for (const job of normalized.jobs) {
    validateFields(job.name, job.fields, { objectNames, blobNames });
  }

  for (const projection of normalized.projections) {
    if (!streamNames.has(projection.source) && !objectNames.has(projection.source)) {
      throw new Error(`Unknown projection source ${projection.source} in ${projection.name}`);
    }
    validateFields(projection.name, projection.fields, { objectNames, blobNames });
    validateIndexes(projection.name, projection.fields, projection.indexes);
  }

  return normalized;
}

export function objectByName(schema: FrickSchema, name: string): ObjectDef {
  return findByName(schema.objects, "object", name);
}

/**
 * Resolve the effective merge policy for an object type. Objects whose
 * {@link ObjectDef.mergePolicy} is omitted fall back to "lastWriteWins".
 * Unknown object types also fall back to "lastWriteWins" — callers that
 * want strict validation should look up the {@link ObjectDef} first.
 */
export function resolveObjectMergePolicy(
  schema: FrickSchema,
  name: string,
): FrickObjectMergePolicy {
  const def = schema.objects.find((candidate) => candidate.name === name);
  return def?.mergePolicy ?? "lastWriteWins";
}

export function objectById(schema: FrickSchema, id: number): ObjectDef {
  return findById(schema.objects, "object", id);
}

export function streamByName(schema: FrickSchema, name: string): StreamDef {
  return findByName(schema.streams, "stream", name);
}

export function streamById(schema: FrickSchema, id: number): StreamDef {
  return findById(schema.streams, "stream", id);
}

export function eventByName(schema: FrickSchema, name: string): EventDef {
  return findByName(schema.events, "event", name);
}

export function eventById(schema: FrickSchema, id: number): EventDef {
  return findById(schema.events, "event", id);
}

export function presenceByName(schema: FrickSchema, name: string): PresenceDef {
  return findByName(schema.presences, "presence", name);
}

export function presenceById(schema: FrickSchema, id: number): PresenceDef {
  return findById(schema.presences, "presence", id);
}

export function signalByName(schema: FrickSchema, name: string): SignalDef {
  return findByName(schema.signals, "signal", name);
}

export function signalById(schema: FrickSchema, id: number): SignalDef {
  return findById(schema.signals, "signal", id);
}

export function blobByName(schema: FrickSchema, name: string): BlobDef {
  return findByName(schema.blobs, "blob", name);
}

export function jobByName(schema: FrickSchema, name: string): JobDef {
  return findByName(schema.jobs, "job", name);
}

export function projectionByName(schema: FrickSchema, name: string): ProjectionDef {
  return findByName(schema.projections, "projection", name);
}

export function fieldByName(fields: readonly FieldDef[], name: string): FieldDef {
  const field = fields.find((candidate) => candidate.name === name);
  if (!field) {
    throw new Error(`Unknown field ${name}`);
  }
  return field;
}

export function fieldById(fields: readonly FieldDef[], id: number): FieldDef {
  const field = fields.find((candidate) => candidate.id === id);
  if (!field) {
    throw new Error(`Unknown field id ${id}`);
  }
  return field;
}

function validateTypeSet(types: readonly { id: number; name: string }[], label: string): void {
  const ids = new Set<number>();
  const names = new Set<string>();

  for (const type of types) {
    if (ids.has(type.id)) {
      throw new Error(`Duplicate ${label} id ${type.id}`);
    }
    ids.add(type.id);

    const lowerName = type.name.toLowerCase();
    if (names.has(lowerName)) {
      throw new Error(`Duplicate ${label} name ${type.name}`);
    }
    names.add(lowerName);
  }
}

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
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validateFields(
  owner: string,
  fields: readonly FieldDef[],
  references: { objectNames: ReadonlySet<string>; blobNames: ReadonlySet<string> },
): void {
  const ids = new Set<number>();
  const names = new Set<string>();

  for (const field of fields) {
    if (ids.has(field.id)) {
      throw new Error(`Duplicate field id ${field.id} in ${owner}`);
    }
    ids.add(field.id);

    const lowerName = field.name.toLowerCase();
    if (names.has(lowerName)) {
      throw new Error(`Duplicate field name ${owner}.${field.name}`);
    }
    names.add(lowerName);

    if (field.kind === "ref" && field.ref && !references.objectNames.has(field.ref) && !references.blobNames.has(field.ref)) {
      throw new Error(`Unknown ref target ${field.ref} in ${owner}.${field.name}`);
    }

    if (field.kind === "enum" && (!field.enumValues || field.enumValues.length === 0)) {
      throw new Error(`Enum field ${owner}.${field.name} must declare enumValues`);
    }

    if (field.sensitivity !== undefined && !FIELD_SENSITIVITY_VALUES.has(field.sensitivity)) {
      throw new Error(
        `Unknown sensitivity "${String(field.sensitivity)}" for field ${owner}.${field.name}`,
      );
    }
  }
}

function validateIndexes(owner: string, fields: readonly FieldDef[], indexes: readonly IndexDef[]): void {
  validateTypeSet(indexes, `${owner} index`);
  const fieldNames = new Set(fields.map((field) => field.name));

  for (const index of indexes) {
    for (const fieldName of index.fields) {
      if (!fieldNames.has(fieldName)) {
        throw new Error(`Unknown index field ${owner}.${index.name}.${fieldName}`);
      }
    }
  }
}

function findByName<T extends { name: string }>(
  types: readonly T[],
  label: string,
  name: string,
): T {
  const type = types.find((candidate) => candidate.name === name);
  if (!type) {
    throw new Error(`Unknown ${label}: ${name}`);
  }
  return type;
}

function findById<T extends { id: number }>(
  types: readonly T[],
  label: string,
  id: number,
): T {
  const type = types.find((candidate) => candidate.id === id);
  if (!type) {
    throw new Error(`Unknown ${label} id: ${id}`);
  }
  return type;
}

function stableClone(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableClone(item));
  }

  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const clone: Record<string, unknown> = {};

    for (const key of Object.keys(object).sort()) {
      const property = object[key];
      if (property !== undefined) {
        clone[key] = stableClone(property);
      }
    }

    return clone;
  }

  return value;
}
