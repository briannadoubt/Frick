/**
 * Schema linter for FrickSchema.
 *
 * Two entry points:
 *  - {@link lintSchema} runs validity checks on a single schema snapshot
 *    (duplicate names, missing identity, etc.).
 *  - {@link lintSchemaChange} diffs two snapshots (current vs previous) and
 *    reports compatibility findings according to section 3 of the framework
 *    hardening spec.
 *
 * Findings carry a stable `ruleId` so downstream tooling (the CLI, the admin
 * route) can suppress or filter rules without parsing free-form messages.
 *
 * The linter never throws on schema content — it always returns a result.
 * The only throws come from defensive guards on argument shape.
 */
import type {
  BlobDef,
  EventDef,
  FieldDef,
  FrickSchema,
  IndexDef,
  JobDef,
  ObjectDef,
  PresenceDef,
  ProjectionDef,
  SignalDef,
  StreamDef,
} from "./schema.js";

export type FrickLintSeverity = "info" | "warn" | "breaking";

export interface FrickLintFinding {
  severity: FrickLintSeverity;
  /** Dotted/bracketed path into the schema, e.g. `objects[User].fields[handle]`. */
  path: string;
  message: string;
  /** Stable rule identifier such as `object.removed`, `field.required.added`. */
  ruleId: string;
}

export interface FrickLintResult {
  findings: FrickLintFinding[];
  breakingCount: number;
}

interface TypeCarrier {
  id: number;
  name: string;
}

function makeResult(findings: FrickLintFinding[]): FrickLintResult {
  return {
    findings,
    breakingCount: findings.filter((f) => f.severity === "breaking").length,
  };
}

/** Single-schema validity lint: duplicate names, missing identity, etc. */
export function lintSchema(schema: FrickSchema): FrickLintResult {
  const findings: FrickLintFinding[] = [];

  if (!isNonEmptyString(schema.schemaId)) {
    findings.push({
      severity: "breaking",
      path: "schemaId",
      message: "schemaId must be a non-empty string",
      ruleId: "schema.identity.missing",
    });
  }
  if (!isPositiveInteger(schema.schemaRevision)) {
    findings.push({
      severity: "breaking",
      path: "schemaRevision",
      message: "schemaRevision must be a positive integer",
      ruleId: "schema.revision.invalid",
    });
  }

  checkDuplicates(findings, schema.objects, "objects", "object");
  checkDuplicates(findings, schema.streams, "streams", "stream");
  checkDuplicates(findings, schema.events, "events", "event");
  checkDuplicates(findings, schema.presences, "presences", "presence");
  checkDuplicates(findings, schema.signals, "signals", "signal");
  checkDuplicates(findings, schema.blobs, "blobs", "blob");
  checkDuplicates(findings, schema.jobs, "jobs", "job");
  checkDuplicates(findings, schema.projections, "projections", "projection");

  for (const obj of schema.objects) {
    checkFieldDuplicates(findings, `objects[${obj.name}]`, obj.fields);
  }
  for (const ev of schema.events) {
    checkFieldDuplicates(findings, `events[${ev.name}]`, ev.fields);
  }

  return makeResult(findings);
}

/** Diff two schema snapshots and report compatibility findings. */
export function lintSchemaChange(
  current: FrickSchema,
  previous: FrickSchema,
): FrickLintResult {
  const findings: FrickLintFinding[] = [];

  // Schema identity / revision rules.
  if (previous.schemaId !== current.schemaId) {
    findings.push({
      severity: "breaking",
      path: "schemaId",
      message: `schemaId changed from ${previous.schemaId} to ${current.schemaId}`,
      ruleId: "schema.id.changed",
    });
  }

  if (current.schemaRevision < previous.schemaRevision) {
    findings.push({
      severity: "breaking",
      path: "schemaRevision",
      message: `schemaRevision decreased from ${previous.schemaRevision} to ${current.schemaRevision}`,
      ruleId: "schema.revision.decreased",
    });
  }

  if (current.minimumClientRevision > previous.minimumClientRevision) {
    findings.push({
      severity: "warn",
      path: "minimumClientRevision",
      message: `minimumClientRevision raised from ${previous.minimumClientRevision} to ${current.minimumClientRevision}`,
      ruleId: "schema.minimumClientRevision.raised",
    });
  }

  // Type-set comparisons (additions/removals).
  diffTypeSet(findings, previous.objects, current.objects, "objects", "object");
  diffTypeSet(findings, previous.streams, current.streams, "streams", "stream");
  diffTypeSet(findings, previous.events, current.events, "events", "event");
  diffTypeSet(
    findings,
    previous.presences,
    current.presences,
    "presences",
    "presence",
  );
  diffTypeSet(findings, previous.signals, current.signals, "signals", "signal");
  diffTypeSet(findings, previous.blobs, current.blobs, "blobs", "blob");
  diffTypeSet(findings, previous.jobs, current.jobs, "jobs", "job");
  diffTypeSet(
    findings,
    previous.projections,
    current.projections,
    "projections",
    "projection",
  );

  // Per-type field diffs (overlapping pairs).
  diffObjects(findings, previous.objects, current.objects);
  diffEvents(findings, previous.events, current.events);
  diffStreams(findings, previous.streams, current.streams);
  diffPresences(findings, previous.presences, current.presences);
  diffSignals(findings, previous.signals, current.signals);
  diffBlobs(findings, previous.blobs, current.blobs);
  diffJobs(findings, previous.jobs, current.jobs);
  diffProjections(findings, previous.projections, current.projections);

  return makeResult(findings);
}

// ---------- type-set diff ----------

function diffTypeSet<T extends TypeCarrier>(
  findings: FrickLintFinding[],
  prev: readonly T[],
  curr: readonly T[],
  collection: string,
  label: string,
): void {
  const currIds = new Map(curr.map((t) => [t.id, t]));
  const prevIds = new Map(prev.map((t) => [t.id, t]));

  for (const p of prev) {
    if (!currIds.has(p.id)) {
      findings.push({
        severity: "breaking",
        path: `${collection}[${p.name}]`,
        message: `${label} ${p.name} (id=${p.id}) was removed`,
        ruleId: `${label}.removed`,
      });
    }
  }
  for (const c of curr) {
    if (!prevIds.has(c.id)) {
      findings.push({
        severity: "info",
        path: `${collection}[${c.name}]`,
        message: `${label} ${c.name} (id=${c.id}) was added`,
        ruleId: `${label}.added`,
      });
    }
  }
  // Renames at the same id are surfaced as breaking under "name changed".
  for (const c of curr) {
    const p = prevIds.get(c.id);
    if (p && p.name !== c.name) {
      findings.push({
        severity: "breaking",
        path: `${collection}[${c.name}]`,
        message: `${label} id ${c.id} renamed from ${p.name} to ${c.name}`,
        ruleId: `${label}.renamed`,
      });
    }
  }
}

// ---------- per-collection field diffs ----------

function diffObjects(
  findings: FrickLintFinding[],
  prev: readonly ObjectDef[],
  curr: readonly ObjectDef[],
): void {
  for (const c of curr) {
    const p = prev.find((x) => x.id === c.id);
    if (!p) continue;
    diffFields(findings, `objects[${c.name}]`, p.fields, c.fields);
    diffIndexes(findings, `objects[${c.name}]`, p.indexes, c.indexes);
  }
}

function diffEvents(
  findings: FrickLintFinding[],
  prev: readonly EventDef[],
  curr: readonly EventDef[],
): void {
  for (const c of curr) {
    const p = prev.find((x) => x.id === c.id);
    if (!p) continue;
    diffFields(findings, `events[${c.name}]`, p.fields, c.fields);
  }
}

function diffStreams(
  findings: FrickLintFinding[],
  prev: readonly StreamDef[],
  curr: readonly StreamDef[],
): void {
  for (const c of curr) {
    const p = prev.find((x) => x.id === c.id);
    if (!p) continue;
    diffFields(findings, `streams[${c.name}].key`, p.keyFields, c.keyFields);
    // Stream event-name set: removal is breaking, addition is info.
    const prevEvents = new Set(p.events);
    const currEvents = new Set(c.events);
    for (const e of prevEvents) {
      if (!currEvents.has(e)) {
        findings.push({
          severity: "breaking",
          path: `streams[${c.name}].events[${e}]`,
          message: `stream ${c.name} no longer emits event ${e}`,
          ruleId: "stream.event.removed",
        });
      }
    }
    for (const e of currEvents) {
      if (!prevEvents.has(e)) {
        findings.push({
          severity: "info",
          path: `streams[${c.name}].events[${e}]`,
          message: `stream ${c.name} added event ${e}`,
          ruleId: "stream.event.added",
        });
      }
    }
  }
}

function diffPresences(
  findings: FrickLintFinding[],
  prev: readonly PresenceDef[],
  curr: readonly PresenceDef[],
): void {
  for (const c of curr) {
    const p = prev.find((x) => x.id === c.id);
    if (!p) continue;
    diffFields(findings, `presences[${c.name}].key`, p.keyFields, c.keyFields);
    diffFields(findings, `presences[${c.name}]`, p.fields, c.fields);
  }
}

function diffSignals(
  findings: FrickLintFinding[],
  prev: readonly SignalDef[],
  curr: readonly SignalDef[],
): void {
  for (const c of curr) {
    const p = prev.find((x) => x.id === c.id);
    if (!p) continue;
    diffFields(findings, `signals[${c.name}].key`, p.keyFields, c.keyFields);
    diffFields(findings, `signals[${c.name}]`, p.fields, c.fields);
  }
}

function diffBlobs(
  findings: FrickLintFinding[],
  prev: readonly BlobDef[],
  curr: readonly BlobDef[],
): void {
  for (const c of curr) {
    const p = prev.find((x) => x.id === c.id);
    if (!p) continue;
    diffFields(
      findings,
      `blobs[${c.name}].metadata`,
      p.metadataFields,
      c.metadataFields,
    );
  }
}

function diffJobs(
  findings: FrickLintFinding[],
  prev: readonly JobDef[],
  curr: readonly JobDef[],
): void {
  for (const c of curr) {
    const p = prev.find((x) => x.id === c.id);
    if (!p) continue;
    diffFields(findings, `jobs[${c.name}]`, p.fields, c.fields);
  }
}

function diffProjections(
  findings: FrickLintFinding[],
  prev: readonly ProjectionDef[],
  curr: readonly ProjectionDef[],
): void {
  for (const c of curr) {
    const p = prev.find((x) => x.id === c.id);
    if (!p) continue;
    if (p.source !== c.source) {
      findings.push({
        severity: "breaking",
        path: `projections[${c.name}].source`,
        message: `projection source changed from ${p.source} to ${c.source}`,
        ruleId: "projection.source.changed",
      });
    }
    diffFields(findings, `projections[${c.name}]`, p.fields, c.fields);
    diffIndexes(findings, `projections[${c.name}]`, p.indexes, c.indexes);
  }
}

// ---------- field diff ----------

function diffFields(
  findings: FrickLintFinding[],
  ownerPath: string,
  prev: readonly FieldDef[],
  curr: readonly FieldDef[],
): void {
  const prevById = new Map(prev.map((f) => [f.id, f]));
  const currById = new Map(curr.map((f) => [f.id, f]));

  // Removed fields (no stable id in current) → breaking.
  for (const p of prev) {
    if (!currById.has(p.id)) {
      findings.push({
        severity: "breaking",
        path: `${ownerPath}.fields[${p.name}]`,
        message: `field ${p.name} (id=${p.id}) was removed`,
        ruleId: "field.removed",
      });
    }
  }

  // Added fields → info (optional) / breaking (required).
  for (const c of curr) {
    if (!prevById.has(c.id)) {
      if (c.required) {
        findings.push({
          severity: "breaking",
          path: `${ownerPath}.fields[${c.name}]`,
          message: `required field ${c.name} was added`,
          ruleId: "field.required.added",
        });
      } else {
        findings.push({
          severity: "info",
          path: `${ownerPath}.fields[${c.name}]`,
          message: `optional field ${c.name} was added`,
          ruleId: "field.optional.added",
        });
      }
    }
  }

  // Per-id field changes.
  for (const c of curr) {
    const p = prevById.get(c.id);
    if (!p) continue;

    // Rename without stable id is impossible since we track by id, but a
    // name change at the same id is still a wire-level rename for clients
    // that look up by name. Per the spec, any string-id change is breaking.
    if (p.name !== c.name) {
      findings.push({
        severity: "breaking",
        path: `${ownerPath}.fields[${c.name}]`,
        message: `field id ${c.id} renamed from ${p.name} to ${c.name}`,
        ruleId: "field.renamed",
      });
    }

    if (p.kind !== c.kind) {
      findings.push({
        severity: "breaking",
        path: `${ownerPath}.fields[${c.name}]`,
        message: `field ${c.name} kind changed from ${p.kind} to ${c.kind}`,
        ruleId: "field.kind.changed",
      });
    }

    if (p.required !== c.required) {
      const ruleId = c.required ? "field.required.toggled" : "field.optional.toggled";
      findings.push({
        severity: "breaking",
        path: `${ownerPath}.fields[${c.name}]`,
        message: `field ${c.name} required flag changed from ${p.required} to ${c.required}`,
        ruleId,
      });
    }

    if ((p.ref ?? "") !== (c.ref ?? "")) {
      findings.push({
        severity: "breaking",
        path: `${ownerPath}.fields[${c.name}]`,
        message: `field ${c.name} ref target changed from ${p.ref ?? "<none>"} to ${c.ref ?? "<none>"}`,
        ruleId: "field.ref.changed",
      });
    }

    diffEnumValues(findings, `${ownerPath}.fields[${c.name}]`, p, c);
  }
}

function diffEnumValues(
  findings: FrickLintFinding[],
  path: string,
  prev: FieldDef,
  curr: FieldDef,
): void {
  if (prev.kind !== "enum" || curr.kind !== "enum") return;
  const prevValues = prev.enumValues ?? [];
  const currValues = curr.enumValues ?? [];
  const currSet = new Set(currValues);
  const prevSet = new Set(prevValues);

  // Any value removed → breaking.
  for (const v of prevValues) {
    if (!currSet.has(v)) {
      findings.push({
        severity: "breaking",
        path,
        message: `enum value ${v} removed`,
        ruleId: "enum.value.removed",
      });
    }
  }

  // Added values: terminal additions (after the previous list) are
  // compatible but worth flagging; mid-list insertions (which can shift
  // numeric encoding for ordinal-encoded enums) are breaking.
  let prevTail = prevValues.length;
  for (let i = 0; i < currValues.length; i += 1) {
    const v = currValues[i]!;
    if (prevSet.has(v)) continue;
    const trailing = i >= prevTail;
    if (trailing) {
      findings.push({
        severity: "warn",
        path,
        message: `enum value ${v} added at the end`,
        ruleId: "enum.value.added.trailing",
      });
    } else {
      findings.push({
        severity: "breaking",
        path,
        message: `enum value ${v} inserted before existing values`,
        ruleId: "enum.value.inserted",
      });
    }
    // Once we've passed the previous-length cursor, every subsequent index
    // is also "trailing" — keep the comparator stable.
    prevTail = Math.max(prevTail, i + 1);
  }
}

function diffIndexes(
  findings: FrickLintFinding[],
  ownerPath: string,
  prev: readonly IndexDef[],
  curr: readonly IndexDef[],
): void {
  const currIds = new Map(curr.map((x) => [x.id, x]));
  for (const p of prev) {
    if (!currIds.has(p.id)) {
      findings.push({
        severity: "breaking",
        path: `${ownerPath}.indexes[${p.name}]`,
        message: `index ${p.name} (id=${p.id}) was removed`,
        ruleId: "index.removed",
      });
    }
  }
}

// ---------- single-schema helpers ----------

function checkDuplicates<T extends TypeCarrier>(
  findings: FrickLintFinding[],
  types: readonly T[],
  collection: string,
  label: string,
): void {
  const names = new Map<string, number>();
  for (const t of types) {
    const key = t.name.toLowerCase();
    names.set(key, (names.get(key) ?? 0) + 1);
  }
  for (const [key, count] of names) {
    if (count > 1) {
      findings.push({
        severity: "breaking",
        path: `${collection}[${key}]`,
        message: `duplicate ${label} name ${key} (${count} occurrences)`,
        ruleId: `${label}.duplicate.name`,
      });
    }
  }
}

function checkFieldDuplicates(
  findings: FrickLintFinding[],
  ownerPath: string,
  fields: readonly FieldDef[],
): void {
  const names = new Map<string, number>();
  for (const f of fields) {
    const key = f.name.toLowerCase();
    names.set(key, (names.get(key) ?? 0) + 1);
  }
  for (const [key, count] of names) {
    if (count > 1) {
      findings.push({
        severity: "breaking",
        path: `${ownerPath}.fields[${key}]`,
        message: `duplicate field name ${key} (${count} occurrences)`,
        ruleId: "field.duplicate.name",
      });
    }
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
