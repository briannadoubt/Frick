//! Breaking-change linter for [`FrickSchema`] snapshots.
//!
//! Ported rule-for-rule from `packages/protocol/src/lint.ts`. Two entry
//! points:
//!
//! - [`lint_schema`] runs validity checks on a single schema snapshot
//!   (duplicate names, missing identity, etc.).
//! - [`lint_schema_change`] diffs two snapshots (current vs previous) and
//!   reports compatibility findings according to section 3 of the framework
//!   hardening spec.
//!
//! Findings carry a stable `rule_id` so downstream tooling (the CLI, the
//! admin route) can suppress or filter rules without parsing free-form
//! messages.
//!
//! The linter never fails on schema content — it always returns a result.
//! The TS implementation's only throws are defensive guards on argument
//! shape, which the Rust types make unrepresentable; nothing here panics.
//!
//! Parity is pinned by the golden fixtures under `conformance/fixtures/lint/`
//! (regenerate with `pnpm fixtures:lint`): every ruleId string, severity,
//! path, message, and the finding *order* must match the TS linter exactly.

use std::collections::{HashMap, HashSet};

use frick_protocol::schema::{
    BlobDef, EventDef, FieldDef, FieldKind, FrickSchema, IndexDef, JobDef, ObjectDef, PresenceDef,
    ProjectionDef, SignalDef, StreamDef,
};
use serde::{Deserialize, Serialize};

/// Severity of a lint finding (`FrickLintSeverity` in TS). Serializes to the
/// exact TS wire strings `"info"` / `"warn"` / `"breaking"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FrickLintSeverity {
    /// Compatible change worth surfacing (e.g. an added optional field).
    Info,
    /// Compatible but risky change (e.g. a trailing enum value).
    Warn,
    /// Wire-breaking change.
    Breaking,
}

impl FrickLintSeverity {
    /// Every value, in declaration order.
    pub const ALL: &'static [Self] = &[Self::Info, Self::Warn, Self::Breaking];

    /// The exact wire string for this value.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Breaking => "breaking",
        }
    }
}

impl core::fmt::Display for FrickLintSeverity {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One lint finding (`FrickLintFinding` in TS). Serializes to
/// `{severity, path, message, ruleId}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrickLintFinding {
    /// How severe the finding is.
    pub severity: FrickLintSeverity,
    /// Dotted/bracketed path into the schema, e.g. `objects[User].fields[handle]`.
    pub path: String,
    /// Human-readable description (byte-identical to the TS linter's text).
    pub message: String,
    /// Stable rule identifier such as `object.removed`, `field.required.added`.
    pub rule_id: String,
}

/// Lint outcome (`FrickLintResult` in TS). Serializes to
/// `{findings, breakingCount}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrickLintResult {
    /// All findings, in the exact order the TS linter emits them.
    pub findings: Vec<FrickLintFinding>,
    /// Count of findings with [`FrickLintSeverity::Breaking`].
    pub breaking_count: usize,
}

/// Anything with a numeric id and a name (the `TypeCarrier` shape in TS).
trait TypeCarrier {
    fn id(&self) -> i64;
    fn name(&self) -> &str;
}

macro_rules! impl_type_carrier {
    ($($ty:ty),+ $(,)?) => {
        $(impl TypeCarrier for $ty {
            fn id(&self) -> i64 {
                self.id
            }

            fn name(&self) -> &str {
                &self.name
            }
        })+
    };
}

impl_type_carrier!(
    ObjectDef,
    StreamDef,
    EventDef,
    PresenceDef,
    SignalDef,
    BlobDef,
    JobDef,
    ProjectionDef,
    IndexDef,
);

fn finding(
    severity: FrickLintSeverity,
    path: impl Into<String>,
    message: impl Into<String>,
    rule_id: impl Into<String>,
) -> FrickLintFinding {
    FrickLintFinding {
        severity,
        path: path.into(),
        message: message.into(),
        rule_id: rule_id.into(),
    }
}

fn make_result(findings: Vec<FrickLintFinding>) -> FrickLintResult {
    let breaking_count = findings
        .iter()
        .filter(|f| f.severity == FrickLintSeverity::Breaking)
        .count();
    FrickLintResult {
        findings,
        breaking_count,
    }
}

/// Single-schema validity lint: duplicate names, missing identity, etc.
#[must_use]
pub fn lint_schema(schema: &FrickSchema) -> FrickLintResult {
    let mut findings = Vec::new();

    if !is_non_empty_string(&schema.schema_id) {
        findings.push(finding(
            FrickLintSeverity::Breaking,
            "schemaId",
            "schemaId must be a non-empty string",
            "schema.identity.missing",
        ));
    }
    if !is_positive_integer(schema.schema_revision) {
        findings.push(finding(
            FrickLintSeverity::Breaking,
            "schemaRevision",
            "schemaRevision must be a positive integer",
            "schema.revision.invalid",
        ));
    }

    check_duplicates(&mut findings, &schema.objects, "objects", "object");
    check_duplicates(&mut findings, &schema.streams, "streams", "stream");
    check_duplicates(&mut findings, &schema.events, "events", "event");
    check_duplicates(&mut findings, &schema.presences, "presences", "presence");
    check_duplicates(&mut findings, &schema.signals, "signals", "signal");
    check_duplicates(&mut findings, &schema.blobs, "blobs", "blob");
    check_duplicates(&mut findings, &schema.jobs, "jobs", "job");
    check_duplicates(
        &mut findings,
        &schema.projections,
        "projections",
        "projection",
    );

    for obj in &schema.objects {
        check_field_duplicates(
            &mut findings,
            &format!("objects[{}]", obj.name),
            &obj.fields,
        );
    }
    for ev in &schema.events {
        check_field_duplicates(&mut findings, &format!("events[{}]", ev.name), &ev.fields);
    }

    make_result(findings)
}

/// Diff two schema snapshots and report compatibility findings.
///
/// Argument order matches TS: **current first, previous second**.
#[must_use]
pub fn lint_schema_change(current: &FrickSchema, previous: &FrickSchema) -> FrickLintResult {
    let mut findings = Vec::new();

    // Schema identity / revision rules.
    if previous.schema_id != current.schema_id {
        findings.push(finding(
            FrickLintSeverity::Breaking,
            "schemaId",
            format!(
                "schemaId changed from {} to {}",
                previous.schema_id, current.schema_id
            ),
            "schema.id.changed",
        ));
    }

    if current.schema_revision < previous.schema_revision {
        findings.push(finding(
            FrickLintSeverity::Breaking,
            "schemaRevision",
            format!(
                "schemaRevision decreased from {} to {}",
                previous.schema_revision, current.schema_revision
            ),
            "schema.revision.decreased",
        ));
    }

    if current.minimum_client_revision > previous.minimum_client_revision {
        findings.push(finding(
            FrickLintSeverity::Warn,
            "minimumClientRevision",
            format!(
                "minimumClientRevision raised from {} to {}",
                previous.minimum_client_revision, current.minimum_client_revision
            ),
            "schema.minimumClientRevision.raised",
        ));
    }

    // Type-set comparisons (additions/removals).
    diff_type_set(
        &mut findings,
        &previous.objects,
        &current.objects,
        "objects",
        "object",
    );
    diff_type_set(
        &mut findings,
        &previous.streams,
        &current.streams,
        "streams",
        "stream",
    );
    diff_type_set(
        &mut findings,
        &previous.events,
        &current.events,
        "events",
        "event",
    );
    diff_type_set(
        &mut findings,
        &previous.presences,
        &current.presences,
        "presences",
        "presence",
    );
    diff_type_set(
        &mut findings,
        &previous.signals,
        &current.signals,
        "signals",
        "signal",
    );
    diff_type_set(
        &mut findings,
        &previous.blobs,
        &current.blobs,
        "blobs",
        "blob",
    );
    diff_type_set(&mut findings, &previous.jobs, &current.jobs, "jobs", "job");
    diff_type_set(
        &mut findings,
        &previous.projections,
        &current.projections,
        "projections",
        "projection",
    );

    // Per-type field diffs (overlapping pairs).
    diff_objects(&mut findings, &previous.objects, &current.objects);
    diff_events(&mut findings, &previous.events, &current.events);
    diff_streams(&mut findings, &previous.streams, &current.streams);
    diff_presences(&mut findings, &previous.presences, &current.presences);
    diff_signals(&mut findings, &previous.signals, &current.signals);
    diff_blobs(&mut findings, &previous.blobs, &current.blobs);
    diff_jobs(&mut findings, &previous.jobs, &current.jobs);
    diff_projections(&mut findings, &previous.projections, &current.projections);

    make_result(findings)
}

// ---------- type-set diff ----------

fn diff_type_set<T: TypeCarrier>(
    findings: &mut Vec<FrickLintFinding>,
    prev: &[T],
    curr: &[T],
    collection: &str,
    label: &str,
) {
    // Like `new Map(...)` in TS, later duplicate ids overwrite earlier ones.
    let curr_ids: HashMap<i64, &T> = curr.iter().map(|t| (t.id(), t)).collect();
    let prev_ids: HashMap<i64, &T> = prev.iter().map(|t| (t.id(), t)).collect();

    for p in prev {
        if !curr_ids.contains_key(&p.id()) {
            findings.push(finding(
                FrickLintSeverity::Breaking,
                format!("{collection}[{}]", p.name()),
                format!("{label} {} (id={}) was removed", p.name(), p.id()),
                format!("{label}.removed"),
            ));
        }
    }
    for c in curr {
        if !prev_ids.contains_key(&c.id()) {
            findings.push(finding(
                FrickLintSeverity::Info,
                format!("{collection}[{}]", c.name()),
                format!("{label} {} (id={}) was added", c.name(), c.id()),
                format!("{label}.added"),
            ));
        }
    }
    // Renames at the same id are surfaced as breaking under "name changed".
    for c in curr {
        if let Some(p) = prev_ids.get(&c.id())
            && p.name() != c.name()
        {
            findings.push(finding(
                FrickLintSeverity::Breaking,
                format!("{collection}[{}]", c.name()),
                format!(
                    "{label} id {} renamed from {} to {}",
                    c.id(),
                    p.name(),
                    c.name()
                ),
                format!("{label}.renamed"),
            ));
        }
    }
}

// ---------- per-collection field diffs ----------

/// First prev entry with the same id, mirroring TS `prev.find(...)` (note:
/// *first* match here, unlike the last-wins maps in [`diff_type_set`]).
fn pair_by_id<'a, T: TypeCarrier>(prev: &'a [T], c: &T) -> Option<&'a T> {
    prev.iter().find(|x| x.id() == c.id())
}

fn diff_objects(findings: &mut Vec<FrickLintFinding>, prev: &[ObjectDef], curr: &[ObjectDef]) {
    for c in curr {
        let Some(p) = pair_by_id(prev, c) else {
            continue;
        };
        diff_fields(
            findings,
            &format!("objects[{}]", c.name),
            &p.fields,
            &c.fields,
        );
        diff_indexes(
            findings,
            &format!("objects[{}]", c.name),
            &p.indexes,
            &c.indexes,
        );
    }
}

fn diff_events(findings: &mut Vec<FrickLintFinding>, prev: &[EventDef], curr: &[EventDef]) {
    for c in curr {
        let Some(p) = pair_by_id(prev, c) else {
            continue;
        };
        diff_fields(
            findings,
            &format!("events[{}]", c.name),
            &p.fields,
            &c.fields,
        );
    }
}

fn diff_streams(findings: &mut Vec<FrickLintFinding>, prev: &[StreamDef], curr: &[StreamDef]) {
    for c in curr {
        let Some(p) = pair_by_id(prev, c) else {
            continue;
        };
        diff_fields(
            findings,
            &format!("streams[{}].key", c.name),
            &p.key_fields,
            &c.key_fields,
        );
        // Stream event-name set: removal is breaking, addition is info.
        // `new Set(...)` dedupes while keeping first-occurrence order.
        let prev_events = dedup_preserving_order(&p.events);
        let curr_events = dedup_preserving_order(&c.events);
        for e in &prev_events {
            if !curr_events.contains(e) {
                findings.push(finding(
                    FrickLintSeverity::Breaking,
                    format!("streams[{}].events[{e}]", c.name),
                    format!("stream {} no longer emits event {e}", c.name),
                    "stream.event.removed",
                ));
            }
        }
        for e in &curr_events {
            if !prev_events.contains(e) {
                findings.push(finding(
                    FrickLintSeverity::Info,
                    format!("streams[{}].events[{e}]", c.name),
                    format!("stream {} added event {e}", c.name),
                    "stream.event.added",
                ));
            }
        }
    }
}

fn diff_presences(
    findings: &mut Vec<FrickLintFinding>,
    prev: &[PresenceDef],
    curr: &[PresenceDef],
) {
    for c in curr {
        let Some(p) = pair_by_id(prev, c) else {
            continue;
        };
        diff_fields(
            findings,
            &format!("presences[{}].key", c.name),
            &p.key_fields,
            &c.key_fields,
        );
        diff_fields(
            findings,
            &format!("presences[{}]", c.name),
            &p.fields,
            &c.fields,
        );
    }
}

fn diff_signals(findings: &mut Vec<FrickLintFinding>, prev: &[SignalDef], curr: &[SignalDef]) {
    for c in curr {
        let Some(p) = pair_by_id(prev, c) else {
            continue;
        };
        diff_fields(
            findings,
            &format!("signals[{}].key", c.name),
            &p.key_fields,
            &c.key_fields,
        );
        diff_fields(
            findings,
            &format!("signals[{}]", c.name),
            &p.fields,
            &c.fields,
        );
    }
}

fn diff_blobs(findings: &mut Vec<FrickLintFinding>, prev: &[BlobDef], curr: &[BlobDef]) {
    for c in curr {
        let Some(p) = pair_by_id(prev, c) else {
            continue;
        };
        diff_fields(
            findings,
            &format!("blobs[{}].metadata", c.name),
            &p.metadata_fields,
            &c.metadata_fields,
        );
    }
}

fn diff_jobs(findings: &mut Vec<FrickLintFinding>, prev: &[JobDef], curr: &[JobDef]) {
    for c in curr {
        let Some(p) = pair_by_id(prev, c) else {
            continue;
        };
        diff_fields(findings, &format!("jobs[{}]", c.name), &p.fields, &c.fields);
    }
}

fn diff_projections(
    findings: &mut Vec<FrickLintFinding>,
    prev: &[ProjectionDef],
    curr: &[ProjectionDef],
) {
    for c in curr {
        let Some(p) = pair_by_id(prev, c) else {
            continue;
        };
        if p.source != c.source {
            findings.push(finding(
                FrickLintSeverity::Breaking,
                format!("projections[{}].source", c.name),
                format!(
                    "projection source changed from {} to {}",
                    p.source, c.source
                ),
                "projection.source.changed",
            ));
        }
        diff_fields(
            findings,
            &format!("projections[{}]", c.name),
            &p.fields,
            &c.fields,
        );
        diff_indexes(
            findings,
            &format!("projections[{}]", c.name),
            &p.indexes,
            &c.indexes,
        );
    }
}

// ---------- field diff ----------

fn diff_fields(
    findings: &mut Vec<FrickLintFinding>,
    owner_path: &str,
    prev: &[FieldDef],
    curr: &[FieldDef],
) {
    // Like `new Map(...)` in TS, later duplicate ids overwrite earlier ones.
    let prev_by_id: HashMap<i64, &FieldDef> = prev.iter().map(|f| (f.id, f)).collect();
    let curr_by_id: HashMap<i64, &FieldDef> = curr.iter().map(|f| (f.id, f)).collect();

    // Removed fields (no stable id in current) → breaking.
    for p in prev {
        if !curr_by_id.contains_key(&p.id) {
            findings.push(finding(
                FrickLintSeverity::Breaking,
                format!("{owner_path}.fields[{}]", p.name),
                format!("field {} (id={}) was removed", p.name, p.id),
                "field.removed",
            ));
        }
    }

    // Added fields → info (optional) / breaking (required).
    for c in curr {
        if !prev_by_id.contains_key(&c.id) {
            if c.required {
                findings.push(finding(
                    FrickLintSeverity::Breaking,
                    format!("{owner_path}.fields[{}]", c.name),
                    format!("required field {} was added", c.name),
                    "field.required.added",
                ));
            } else {
                findings.push(finding(
                    FrickLintSeverity::Info,
                    format!("{owner_path}.fields[{}]", c.name),
                    format!("optional field {} was added", c.name),
                    "field.optional.added",
                ));
            }
        }
    }

    // Per-id field changes.
    for c in curr {
        let Some(p) = prev_by_id.get(&c.id).copied() else {
            continue;
        };

        // Rename without stable id is impossible since we track by id, but a
        // name change at the same id is still a wire-level rename for clients
        // that look up by name. Per the spec, any string-id change is breaking.
        if p.name != c.name {
            findings.push(finding(
                FrickLintSeverity::Breaking,
                format!("{owner_path}.fields[{}]", c.name),
                format!("field id {} renamed from {} to {}", c.id, p.name, c.name),
                "field.renamed",
            ));
        }

        if p.kind != c.kind {
            findings.push(finding(
                FrickLintSeverity::Breaking,
                format!("{owner_path}.fields[{}]", c.name),
                format!(
                    "field {} kind changed from {} to {}",
                    c.name, p.kind, c.kind
                ),
                "field.kind.changed",
            ));
        }

        if p.required != c.required {
            let rule_id = if c.required {
                "field.required.toggled"
            } else {
                "field.optional.toggled"
            };
            findings.push(finding(
                FrickLintSeverity::Breaking,
                format!("{owner_path}.fields[{}]", c.name),
                format!(
                    "field {} required flag changed from {} to {}",
                    c.name, p.required, c.required
                ),
                rule_id,
            ));
        }

        // `(p.ref ?? "") !== (c.ref ?? "")` — so None and Some("") compare
        // equal, but the *message* falls back to `<none>` only for None.
        if p.ref_.as_deref().unwrap_or("") != c.ref_.as_deref().unwrap_or("") {
            findings.push(finding(
                FrickLintSeverity::Breaking,
                format!("{owner_path}.fields[{}]", c.name),
                format!(
                    "field {} ref target changed from {} to {}",
                    c.name,
                    p.ref_.as_deref().unwrap_or("<none>"),
                    c.ref_.as_deref().unwrap_or("<none>")
                ),
                "field.ref.changed",
            ));
        }

        diff_enum_values(findings, &format!("{owner_path}.fields[{}]", c.name), p, c);
    }
}

fn diff_enum_values(
    findings: &mut Vec<FrickLintFinding>,
    path: &str,
    prev: &FieldDef,
    curr: &FieldDef,
) {
    if prev.kind != FieldKind::Enum || curr.kind != FieldKind::Enum {
        return;
    }
    let prev_values: &[String] = prev.enum_values.as_deref().unwrap_or(&[]);
    let curr_values: &[String] = curr.enum_values.as_deref().unwrap_or(&[]);
    let curr_set: HashSet<&str> = curr_values.iter().map(String::as_str).collect();
    let prev_set: HashSet<&str> = prev_values.iter().map(String::as_str).collect();

    // Any value removed → breaking.
    for v in prev_values {
        if !curr_set.contains(v.as_str()) {
            findings.push(finding(
                FrickLintSeverity::Breaking,
                path,
                format!("enum value {v} removed"),
                "enum.value.removed",
            ));
        }
    }

    // Added values: terminal additions (after the previous list) are
    // compatible but worth flagging; mid-list insertions (which can shift
    // numeric encoding for ordinal-encoded enums) are breaking.
    let mut prev_tail = prev_values.len();
    for (i, v) in curr_values.iter().enumerate() {
        if prev_set.contains(v.as_str()) {
            continue;
        }
        let trailing = i >= prev_tail;
        if trailing {
            findings.push(finding(
                FrickLintSeverity::Warn,
                path,
                format!("enum value {v} added at the end"),
                "enum.value.added.trailing",
            ));
        } else {
            findings.push(finding(
                FrickLintSeverity::Breaking,
                path,
                format!("enum value {v} inserted before existing values"),
                "enum.value.inserted",
            ));
        }
        // Once we've passed the previous-length cursor, every subsequent index
        // is also "trailing" — keep the comparator stable.
        prev_tail = prev_tail.max(i + 1);
    }
}

fn diff_indexes(
    findings: &mut Vec<FrickLintFinding>,
    owner_path: &str,
    prev: &[IndexDef],
    curr: &[IndexDef],
) {
    let curr_ids: HashSet<i64> = curr.iter().map(|x| x.id).collect();
    for p in prev {
        if !curr_ids.contains(&p.id) {
            findings.push(finding(
                FrickLintSeverity::Breaking,
                format!("{owner_path}.indexes[{}]", p.name),
                format!("index {} (id={}) was removed", p.name, p.id),
                "index.removed",
            ));
        }
    }
}

// ---------- single-schema helpers ----------

fn check_duplicates<T: TypeCarrier>(
    findings: &mut Vec<FrickLintFinding>,
    types: &[T],
    collection: &str,
    label: &str,
) {
    for (key, count) in lowercase_counts(types.iter().map(TypeCarrier::name)) {
        if count > 1 {
            findings.push(finding(
                FrickLintSeverity::Breaking,
                format!("{collection}[{key}]"),
                format!("duplicate {label} name {key} ({count} occurrences)"),
                format!("{label}.duplicate.name"),
            ));
        }
    }
}

fn check_field_duplicates(
    findings: &mut Vec<FrickLintFinding>,
    owner_path: &str,
    fields: &[FieldDef],
) {
    for (key, count) in lowercase_counts(fields.iter().map(|f| f.name.as_str())) {
        if count > 1 {
            findings.push(finding(
                FrickLintSeverity::Breaking,
                format!("{owner_path}.fields[{key}]"),
                format!("duplicate field name {key} ({count} occurrences)"),
                "field.duplicate.name",
            ));
        }
    }
}

/// Lower-cased occurrence counts in first-insertion order, mirroring the
/// iteration order of the TS `Map<string, number>` accumulator.
fn lowercase_counts<'a>(names: impl Iterator<Item = &'a str>) -> Vec<(String, usize)> {
    let mut counts: Vec<(String, usize)> = Vec::new();
    for name in names {
        let key = name.to_lowercase();
        if let Some(entry) = counts.iter_mut().find(|(existing, _)| *existing == key) {
            entry.1 += 1;
        } else {
            counts.push((key, 1));
        }
    }
    counts
}

/// First-occurrence dedup, mirroring `new Set(array)` iteration order in TS.
fn dedup_preserving_order(values: &[String]) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    for value in values {
        if !out.contains(&value.as_str()) {
            out.push(value);
        }
    }
    out
}

fn is_non_empty_string(value: &str) -> bool {
    !value.trim().is_empty()
}

fn is_positive_integer(value: i64) -> bool {
    value > 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(id: i64, name: &str, kind: FieldKind, required: bool) -> FieldDef {
        FieldDef {
            id,
            name: name.to_owned(),
            kind,
            required,
            ref_: None,
            enum_values: None,
            sensitivity: None,
        }
    }

    fn enum_field(id: i64, name: &str, values: &[&str]) -> FieldDef {
        FieldDef {
            enum_values: Some(values.iter().map(|v| (*v).to_owned()).collect()),
            ..field(id, name, FieldKind::Enum, true)
        }
    }

    fn rule_ids(findings: &[FrickLintFinding]) -> Vec<&str> {
        findings.iter().map(|f| f.rule_id.as_str()).collect()
    }

    #[test]
    fn enum_prev_tail_cursor_marks_runs_after_an_append_as_trailing() {
        // prev ["a","b"] → curr ["x","a","b","y","z"]: x is a mid-list
        // insertion; y and z are trailing (z because the cursor advanced).
        let prev = enum_field(1, "state", &["a", "b"]);
        let curr = enum_field(1, "state", &["x", "a", "b", "y", "z"]);
        let mut findings = Vec::new();
        diff_enum_values(&mut findings, "p", &prev, &curr);
        assert_eq!(
            rule_ids(&findings),
            [
                "enum.value.inserted",
                "enum.value.added.trailing",
                "enum.value.added.trailing",
            ]
        );
        assert_eq!(
            findings[0].message,
            "enum value x inserted before existing values"
        );
        assert_eq!(findings[1].message, "enum value y added at the end");
        assert_eq!(findings[2].message, "enum value z added at the end");
    }

    #[test]
    fn enum_diff_skipped_unless_both_sides_are_enums() {
        let prev = enum_field(1, "state", &["a"]);
        let curr = field(1, "state", FieldKind::String, true);
        let mut findings = Vec::new();
        diff_enum_values(&mut findings, "p", &prev, &curr);
        assert!(findings.is_empty());
    }

    #[test]
    fn enum_values_default_to_empty_lists() {
        // prev enum without enumValues (`?? []`): everything in curr is new
        // and trailing because prevTail starts at 0.
        let prev = field(1, "state", FieldKind::Enum, true);
        let curr = enum_field(1, "state", &["a"]);
        let mut findings = Vec::new();
        diff_enum_values(&mut findings, "p", &prev, &curr);
        assert_eq!(rule_ids(&findings), ["enum.value.added.trailing"]);
    }

    #[test]
    fn ref_none_and_empty_string_compare_equal_but_message_uses_none_marker() {
        let prev = field(1, "target", FieldKind::Ref, true);
        let mut curr = field(1, "target", FieldKind::Ref, true);
        curr.ref_ = Some(String::new());
        let mut findings = Vec::new();
        diff_fields(
            &mut findings,
            "objects[T]",
            std::slice::from_ref(&prev),
            &[curr],
        );
        assert!(findings.is_empty(), "None vs Some(\"\") must not lint");

        let mut curr = field(1, "target", FieldKind::Ref, true);
        curr.ref_ = Some("User".to_owned());
        let mut findings = Vec::new();
        diff_fields(&mut findings, "objects[T]", &[prev], &[curr]);
        assert_eq!(rule_ids(&findings), ["field.ref.changed"]);
        assert_eq!(
            findings[0].message,
            "field target ref target changed from <none> to User"
        );
    }

    #[test]
    fn required_toggle_rule_id_depends_on_the_new_value() {
        let mut findings = Vec::new();
        diff_fields(
            &mut findings,
            "objects[T]",
            &[field(1, "a", FieldKind::String, false)],
            &[field(1, "a", FieldKind::String, true)],
        );
        assert_eq!(rule_ids(&findings), ["field.required.toggled"]);

        let mut findings = Vec::new();
        diff_fields(
            &mut findings,
            "objects[T]",
            &[field(1, "a", FieldKind::String, true)],
            &[field(1, "a", FieldKind::String, false)],
        );
        assert_eq!(rule_ids(&findings), ["field.optional.toggled"]);
        assert_eq!(
            findings[0].message,
            "field a required flag changed from true to false"
        );
    }

    #[test]
    fn duplicate_field_ids_resolve_last_wins_like_js_maps() {
        // TS `new Map(prev.map((f) => [f.id, f]))` keeps the *last* entry per
        // id, so the pair diff compares against the second prev field and
        // reports nothing here.
        let prev = [
            field(1, "a", FieldKind::String, true),
            field(1, "b", FieldKind::Int, true),
        ];
        let curr = [field(1, "b", FieldKind::Int, true)];
        let mut findings = Vec::new();
        diff_fields(&mut findings, "objects[T]", &prev, &curr);
        assert!(findings.is_empty());
    }

    #[test]
    fn lowercase_counts_preserve_first_insertion_order() {
        let counts = lowercase_counts(["Beta", "alpha", "beta", "ALPHA", "gamma"].into_iter());
        assert_eq!(
            counts,
            [
                ("beta".to_owned(), 2),
                ("alpha".to_owned(), 2),
                ("gamma".to_owned(), 1),
            ]
        );
    }

    #[test]
    fn severity_wire_strings_round_trip() {
        for severity in FrickLintSeverity::ALL {
            let json = serde_json::to_string(severity).expect("serialize");
            assert_eq!(json, format!("\"{severity}\""));
            let back: FrickLintSeverity = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(back, *severity);
        }
    }

    #[test]
    fn finding_serializes_with_camel_case_rule_id() {
        let value = serde_json::to_value(finding(
            FrickLintSeverity::Breaking,
            "objects[User]",
            "object User (id=1) was removed",
            "object.removed",
        ))
        .expect("serialize");
        assert_eq!(
            value,
            serde_json::json!({
                "severity": "breaking",
                "path": "objects[User]",
                "message": "object User (id=1) was removed",
                "ruleId": "object.removed",
            })
        );
    }
}
