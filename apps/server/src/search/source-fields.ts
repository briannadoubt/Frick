import type {
  FrickSearchDoc,
  FrickSearchHit,
  FrickSearchProjectInput,
} from "./types.js";

const SOURCE_FIELD_PREFIX = "__frickSource";
const SOURCE_KIND_FIELD = `${SOURCE_FIELD_PREFIX}Kind`;
const SOURCE_TYPE_FIELD = `${SOURCE_FIELD_PREFIX}Type`;
const SOURCE_ID_FIELD = `${SOURCE_FIELD_PREFIX}Id`;
const SOURCE_EVENT_ID_FIELD = `${SOURCE_FIELD_PREFIX}EventId`;

export type FrickSearchSourceKind = "object" | "stream" | "projection";

export interface FrickSearchSourceFields {
  kind?: FrickSearchSourceKind;
  type?: string;
  id?: string;
  eventId?: string;
}

export function isReservedSearchField(key: string): boolean {
  return key.startsWith(SOURCE_FIELD_PREFIX);
}

export function withSearchSourceFields(
  input: FrickSearchProjectInput,
  doc: FrickSearchDoc,
): FrickSearchDoc {
  const sourceFields = searchSourceFieldsForInput(input);
  if (!sourceFields) return doc;
  return {
    ...doc,
    fields: {
      ...(doc.fields ?? {}),
      ...sourceFields,
    },
  };
}

export function searchSourceFromHit(hit: FrickSearchHit): FrickSearchSourceFields {
  const kind = hit.fields[SOURCE_KIND_FIELD];
  const type = hit.fields[SOURCE_TYPE_FIELD];
  const id = hit.fields[SOURCE_ID_FIELD];
  const eventId = hit.fields[SOURCE_EVENT_ID_FIELD];
  return {
    ...(isSearchSourceKind(kind) ? { kind } : {}),
    ...(typeof type === "string" ? { type } : {}),
    ...(typeof id === "string" ? { id } : {}),
    ...(typeof eventId === "string" ? { eventId } : {}),
  };
}

export function stripSearchSourceFields(hit: FrickSearchHit): FrickSearchHit {
  const fields = Object.fromEntries(
    Object.entries(hit.fields).filter(([key]) => !isReservedSearchField(key)),
  ) as Record<string, string | number>;
  return { ...hit, fields };
}

function searchSourceFieldsForInput(
  input: FrickSearchProjectInput,
): Record<string, string> | undefined {
  if (input.object) {
    return {
      [SOURCE_KIND_FIELD]: "object",
      [SOURCE_TYPE_FIELD]: input.object.type,
      [SOURCE_ID_FIELD]: input.object.id,
    };
  }
  if (input.streamEvent) {
    return {
      [SOURCE_KIND_FIELD]: "stream",
      [SOURCE_TYPE_FIELD]: input.streamEvent.stream,
      [SOURCE_ID_FIELD]: input.streamEvent.streamId,
      [SOURCE_EVENT_ID_FIELD]: input.streamEvent.eventId,
    };
  }
  if (input.projectionRow) {
    return {
      [SOURCE_KIND_FIELD]: "projection",
      [SOURCE_TYPE_FIELD]: input.projectionRow.name,
      [SOURCE_ID_FIELD]: input.projectionRow.key,
    };
  }
  return undefined;
}

function isSearchSourceKind(value: unknown): value is FrickSearchSourceKind {
  return value === "object" || value === "stream" || value === "projection";
}
