import {
  eventById,
  eventByName,
  fieldById,
  fieldByName,
  objectById,
  objectByName,
  presenceById,
  presenceByName,
  signalById,
  signalByName,
  streamById,
  streamByName,
  type FieldDef,
  type FrickSchema,
  type PackedField,
  type PackedRecord,
  type PlainObject,
} from "./schema.js";

export type PackedStreamEvent = [
  streamTypeId: number,
  streamKey: string,
  sequence: number,
  eventId: string,
  eventTypeId: number,
  fields: PackedField[],
];

export type PackedPresenceRecord = [
  presenceTypeId: number,
  presenceKey: string,
  fields: PackedField[],
];

export type PackedSignalEnvelope = [
  signalTypeId: number,
  signalKey: string,
  fields: PackedField[],
];

export interface StreamEventInput {
  stream: string;
  streamId: string;
  sequence: number;
  eventId: string;
  event: string;
  payload: PlainObject;
}

export function packObjectRecord(
  schema: FrickSchema,
  objectName: string,
  objectId: string,
  value: PlainObject,
): PackedRecord {
  const object = objectByName(schema, objectName);
  return [object.id, objectId, packFields(object.fields, value)];
}

export function unpackObjectRecord(
  schema: FrickSchema,
  packed: PackedRecord,
): { type: string; id: string; value: PlainObject } {
  const object = objectById(schema, packed[0]);
  return {
    type: object.name,
    id: packed[1],
    value: { id: packed[1], ...unpackFields(object.fields, packed[2]) },
  };
}

export function packStreamEvent(
  schema: FrickSchema,
  input: StreamEventInput,
): PackedStreamEvent {
  const stream = streamByName(schema, input.stream);
  const event = eventByName(schema, input.event);
  return [
    stream.id,
    input.streamId,
    input.sequence,
    input.eventId,
    event.id,
    packFields(event.fields, input.payload),
  ];
}

export function unpackStreamEvent(
  schema: FrickSchema,
  packed: PackedStreamEvent,
): StreamEventInput {
  const stream = streamById(schema, packed[0]);
  const event = eventById(schema, packed[4]);
  return {
    stream: stream.name,
    streamId: packed[1],
    sequence: packed[2],
    eventId: packed[3],
    event: event.name,
    payload: unpackFields(event.fields, packed[5]),
  };
}

export function packPresenceRecord(
  schema: FrickSchema,
  presenceName: string,
  presenceKey: string,
  value: PlainObject,
): PackedPresenceRecord {
  const presence = presenceByName(schema, presenceName);
  return [presence.id, presenceKey, packFields(presence.fields, value)];
}

export function unpackPresenceRecord(
  schema: FrickSchema,
  packed: PackedPresenceRecord,
): { type: string; key: string; value: PlainObject } {
  const presence = presenceById(schema, packed[0]);
  return {
    type: presence.name,
    key: packed[1],
    value: unpackFields(presence.fields, packed[2]),
  };
}

export function packSignalEnvelope(
  schema: FrickSchema,
  signalName: string,
  signalKey: string,
  value: PlainObject,
): PackedSignalEnvelope {
  const signal = signalByName(schema, signalName);
  return [signal.id, signalKey, packFields(signal.fields, value)];
}

export function unpackSignalEnvelope(
  schema: FrickSchema,
  packed: PackedSignalEnvelope,
): { type: string; key: string; value: PlainObject } {
  const signal = signalById(schema, packed[0]);
  return {
    type: signal.name,
    key: packed[1],
    value: unpackFields(signal.fields, packed[2]),
  };
}

function packFields(fields: readonly FieldDef[], value: PlainObject): PackedField[] {
  return Object.entries(value).map(([fieldName, fieldValue]) => {
    const field = fieldByName(fields, fieldName);
    return [field.id, fieldValue];
  });
}

function unpackFields(fields: readonly FieldDef[], packed: readonly PackedField[]): PlainObject {
  const value: PlainObject = {};
  for (const [fieldId, fieldValue] of packed) {
    const field = fieldById(fields, fieldId);
    value[field.name] = fieldValue;
  }
  return value;
}
