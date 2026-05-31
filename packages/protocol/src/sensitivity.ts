/**
 * Field-level sensitivity redaction.
 *
 * Schema field definitions may carry a {@link FieldSensitivity} classification
 * (see {@link FieldDef.sensitivity}). This module turns that classification
 * into a concrete redaction policy that logging, diagnostics, and admin
 * inspection paths can apply so that `secret` / `pii` (and optionally
 * `content`) field values never appear in their output.
 *
 * Redaction here is schema-driven and complements the name-based redaction the
 * server's structured logger performs: the logger guesses from field *names*,
 * while this helper masks based on the *declared* classification of a record's
 * fields. Both are defense-in-depth.
 */

import {
  DEFAULT_FIELD_SENSITIVITY,
  resolveFieldSensitivity,
  type FieldDef,
  type FieldSensitivity,
  type PlainObject,
} from "./schema.js";

/** Placeholder substituted for any field value that is masked. */
export const REDACTED_FIELD_VALUE = "<redacted>";

/**
 * Classifications that are masked by the default redaction policy. `secret`
 * and `pii` are always masked; `content` is included so privacy-safe logs and
 * inspection avoid raw user-generated values. `public` and `private` values
 * pass through unchanged — `private` is the conservative default but is still
 * a legitimate authorized read, so we do not blank it in inspection output.
 */
export const DEFAULT_REDACTED_SENSITIVITIES: readonly FieldSensitivity[] = [
  "pii",
  "secret",
  "content",
];

export interface RedactRecordOptions {
  /**
   * Override which classifications are masked. Defaults to
   * {@link DEFAULT_REDACTED_SENSITIVITIES}. Pass e.g. `["secret"]` to mask only
   * credentials, or include `"private"` to harden inspection further.
   */
  readonly redact?: readonly FieldSensitivity[];
  /** Placeholder to substitute. Defaults to {@link REDACTED_FIELD_VALUE}. */
  readonly placeholder?: unknown;
}

/**
 * Build a lookup from field name to effective sensitivity for a set of field
 * definitions. Fields without an explicit annotation resolve to
 * {@link DEFAULT_FIELD_SENSITIVITY}.
 */
export function fieldSensitivityMap(
  fields: readonly FieldDef[],
): ReadonlyMap<string, FieldSensitivity> {
  const map = new Map<string, FieldSensitivity>();
  for (const field of fields) {
    map.set(field.name, resolveFieldSensitivity(field));
  }
  return map;
}

/**
 * Return whether a record value should be masked given the effective
 * sensitivity of its field and the active redaction set.
 */
export function shouldRedactSensitivity(
  sensitivity: FieldSensitivity,
  redact: readonly FieldSensitivity[] = DEFAULT_REDACTED_SENSITIVITIES,
): boolean {
  return redact.includes(sensitivity);
}

/**
 * Return a shallow copy of `record` with every field whose declared
 * sensitivity is in the redaction set replaced by the placeholder. Field names
 * that are not present in `fields` keep their value (defaulting to the
 * conservative {@link DEFAULT_FIELD_SENSITIVITY}, which is not redacted by the
 * default policy). The original record is never mutated.
 */
export function redactRecord(
  record: PlainObject,
  fields: readonly FieldDef[],
  options: RedactRecordOptions = {},
): PlainObject {
  const redact = options.redact ?? DEFAULT_REDACTED_SENSITIVITIES;
  // Use an explicit "has property" check so `null`/`undefined` are valid
  // placeholders rather than silently falling back to the default.
  const placeholder = "placeholder" in options ? options.placeholder : REDACTED_FIELD_VALUE;
  const sensitivities = fieldSensitivityMap(fields);

  const result: PlainObject = {};
  for (const [key, value] of Object.entries(record)) {
    const sensitivity = sensitivities.get(key) ?? DEFAULT_FIELD_SENSITIVITY;
    result[key] = shouldRedactSensitivity(sensitivity, redact) ? placeholder : value;
  }
  return result;
}

/** Convenience wrapper to redact a list of records with the same field set. */
export function redactRecords(
  records: readonly PlainObject[],
  fields: readonly FieldDef[],
  options: RedactRecordOptions = {},
): PlainObject[] {
  return records.map((record) => redactRecord(record, fields, options));
}
