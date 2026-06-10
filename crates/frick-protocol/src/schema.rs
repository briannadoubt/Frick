//! The canonical schema AST, validation, and lookups.
//!
//! Mirrors `packages/protocol/src/schema.ts`. Two encoding-order facts carry
//! over from TS:
//!
//! - Struct fields are declared in the TS *interface* order, so derived
//!   serialization matches payloads built field-by-field in TS.
//! - `validateSchema` in TS returns a `stableClone` (recursively key-sorted)
//!   of its input, and servers send that normalized form on the wire. The
//!   frame encoder therefore serializes schemas through
//!   [`crate::value::stable_value`].
//!
//! `FrickSchema.hash` is a hand-authored opaque identity string — nothing in
//! either implementation computes it; the only operation ever performed on
//! it is string equality.

use serde::{Deserialize, Serialize};

use crate::errors::ProtocolError;
use crate::value::string_enum;

string_enum! {
    /// Field value kinds (`FieldKind` in TS).
    pub enum FieldKind {
        Id => "id",
        Ref => "ref",
        String => "string",
        Bool => "bool",
        Timestamp => "timestamp",
        Int => "int",
        Bytes => "bytes",
        Enum => "enum",
        Json => "json",
    }
}

string_enum! {
    /// Sensitivity classification for a field's values (`FieldSensitivity`).
    pub enum FieldSensitivity {
        Public => "public",
        Private => "private",
        Pii => "pii",
        Secret => "secret",
        Content => "content",
    }
}

/// Default classification applied to fields that omit `sensitivity` —
/// conservative by design (see the TS doc comment).
pub const DEFAULT_FIELD_SENSITIVITY: FieldSensitivity = FieldSensitivity::Private;

string_enum! {
    /// How conflicting writes to the same object are resolved on the server.
    pub enum FrickObjectMergePolicy {
        LastWriteWins => "lastWriteWins",
        VersionPrecondition => "versionPrecondition",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldDef {
    pub id: i64,
    pub name: String,
    pub kind: FieldKind,
    pub required: bool,
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub ref_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<String>>,
    /// Kept as a raw string (not the [`FieldSensitivity`] enum) so that, like
    /// TS, an unknown value survives decode and is rejected by
    /// [`validate_schema`] with the owner/field context — and round-trips
    /// byte-identically until then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sensitivity: Option<String>,
}

impl FieldDef {
    /// Effective sensitivity, falling back to [`DEFAULT_FIELD_SENSITIVITY`]
    /// (`resolveFieldSensitivity` in TS). Unknown strings — which
    /// [`validate_schema`] rejects — also fall back to the default here.
    #[must_use]
    pub fn resolve_sensitivity(&self) -> FieldSensitivity {
        self.sensitivity
            .as_deref()
            .and_then(|text| text.parse().ok())
            .unwrap_or(DEFAULT_FIELD_SENSITIVITY)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDef {
    pub id: i64,
    pub name: String,
    pub fields: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDef {
    pub id: i64,
    pub name: String,
    pub fields: Vec<FieldDef>,
    pub indexes: Vec<IndexDef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_policy: Option<FrickObjectMergePolicy>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamDef {
    pub id: i64,
    pub name: String,
    pub key_fields: Vec<FieldDef>,
    pub events: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDef {
    pub id: i64,
    pub name: String,
    pub fields: Vec<FieldDef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceDef {
    pub id: i64,
    pub name: String,
    pub key_fields: Vec<FieldDef>,
    pub fields: Vec<FieldDef>,
    pub ttl_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalDef {
    pub id: i64,
    pub name: String,
    pub key_fields: Vec<FieldDef>,
    pub fields: Vec<FieldDef>,
    pub ttl_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobDef {
    pub id: i64,
    pub name: String,
    pub metadata_fields: Vec<FieldDef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDef {
    pub id: i64,
    pub name: String,
    pub fields: Vec<FieldDef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionDef {
    pub id: i64,
    pub name: String,
    pub source: String,
    pub fields: Vec<FieldDef>,
    pub indexes: Vec<IndexDef>,
}

/// The canonical Frick schema (`FrickSchema` in TS). Field order matches the
/// TS interface; wire encoding always goes through the stable (key-sorted)
/// form, matching `validateSchema`'s normalized output.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrickSchema {
    pub name: String,
    pub schema_id: String,
    pub schema_version: String,
    pub schema_revision: i64,
    pub minimum_client_revision: i64,
    pub minimum_server_revision: i64,
    pub protocol: String,
    pub protocol_version: i64,
    pub compatibility: String,
    pub hash: String,
    pub objects: Vec<ObjectDef>,
    pub streams: Vec<StreamDef>,
    pub events: Vec<EventDef>,
    pub presences: Vec<PresenceDef>,
    pub signals: Vec<SignalDef>,
    pub blobs: Vec<BlobDef>,
    pub jobs: Vec<JobDef>,
    pub projections: Vec<ProjectionDef>,
}

/// `Record<string, unknown>` in TS — a dynamic msgpack map.
pub type PlainObject = crate::value::Value;

type Result<T> = core::result::Result<T, ProtocolError>;

/// Validate a schema, mirroring `validateSchema` (same checks, same error
/// messages). The TS version also returns a key-sorted clone; in Rust the
/// struct shape is fixed, so normalization is applied at serialization time
/// instead (see [`crate::value::stable_value`]).
pub fn validate_schema(schema: &FrickSchema) -> Result<()> {
    if schema.protocol != "frick.realtime" {
        return Err(ProtocolError::new(format!(
            "Unsupported protocol: {}",
            schema.protocol
        )));
    }
    if schema.compatibility != "greenfield-cutover" {
        return Err(ProtocolError::new(format!(
            "Unsupported compatibility mode: {}",
            schema.compatibility
        )));
    }
    validate_schema_identity(schema)?;

    validate_type_set(
        schema.objects.iter().map(|t| (t.id, t.name.as_str())),
        "object",
    )?;
    validate_type_set(
        schema.streams.iter().map(|t| (t.id, t.name.as_str())),
        "stream",
    )?;
    validate_type_set(
        schema.events.iter().map(|t| (t.id, t.name.as_str())),
        "event",
    )?;
    validate_type_set(
        schema.presences.iter().map(|t| (t.id, t.name.as_str())),
        "presence",
    )?;
    validate_type_set(
        schema.signals.iter().map(|t| (t.id, t.name.as_str())),
        "signal",
    )?;
    validate_type_set(schema.blobs.iter().map(|t| (t.id, t.name.as_str())), "blob")?;
    validate_type_set(schema.jobs.iter().map(|t| (t.id, t.name.as_str())), "job")?;
    validate_type_set(
        schema.projections.iter().map(|t| (t.id, t.name.as_str())),
        "projection",
    )?;

    let object_names: Vec<&str> = schema.objects.iter().map(|t| t.name.as_str()).collect();
    let event_names: Vec<&str> = schema.events.iter().map(|t| t.name.as_str()).collect();
    let stream_names: Vec<&str> = schema.streams.iter().map(|t| t.name.as_str()).collect();
    let blob_names: Vec<&str> = schema.blobs.iter().map(|t| t.name.as_str()).collect();
    let refs = RefTargets {
        object_names: &object_names,
        blob_names: &blob_names,
    };

    for object in &schema.objects {
        validate_fields(&object.name, &object.fields, refs)?;
        validate_indexes(&object.name, &object.fields, &object.indexes)?;
    }

    for stream in &schema.streams {
        validate_fields(&format!("{}.key", stream.name), &stream.key_fields, refs)?;
        for event in &stream.events {
            if !event_names.contains(&event.as_str()) {
                return Err(ProtocolError::new(format!(
                    "Unknown stream event {event} in {}",
                    stream.name
                )));
            }
        }
    }

    for event in &schema.events {
        validate_fields(&event.name, &event.fields, refs)?;
    }

    for presence in &schema.presences {
        validate_fields(
            &format!("{}.key", presence.name),
            &presence.key_fields,
            refs,
        )?;
        validate_fields(&presence.name, &presence.fields, refs)?;
    }

    for signal in &schema.signals {
        validate_fields(&format!("{}.key", signal.name), &signal.key_fields, refs)?;
        validate_fields(&signal.name, &signal.fields, refs)?;
    }

    for blob in &schema.blobs {
        validate_fields(&blob.name, &blob.metadata_fields, refs)?;
    }

    for job in &schema.jobs {
        validate_fields(&job.name, &job.fields, refs)?;
    }

    for projection in &schema.projections {
        if !stream_names.contains(&projection.source.as_str())
            && !object_names.contains(&projection.source.as_str())
        {
            return Err(ProtocolError::new(format!(
                "Unknown projection source {} in {}",
                projection.source, projection.name
            )));
        }
        validate_fields(&projection.name, &projection.fields, refs)?;
        validate_indexes(&projection.name, &projection.fields, &projection.indexes)?;
    }

    Ok(())
}

#[derive(Clone, Copy)]
struct RefTargets<'a> {
    object_names: &'a [&'a str],
    blob_names: &'a [&'a str],
}

fn validate_schema_identity(schema: &FrickSchema) -> Result<()> {
    if schema.schema_id.trim().is_empty() {
        return Err(ProtocolError::new("schemaId must be a non-empty string"));
    }
    if schema.schema_version.trim().is_empty() {
        return Err(ProtocolError::new(
            "schemaVersion must be a non-empty string",
        ));
    }
    if schema.schema_revision <= 0 {
        return Err(ProtocolError::new(
            "schemaRevision must be a positive integer",
        ));
    }
    if schema.minimum_client_revision <= 0 {
        return Err(ProtocolError::new(
            "minimumClientRevision must be a positive integer",
        ));
    }
    if schema.minimum_server_revision <= 0 {
        return Err(ProtocolError::new(
            "minimumServerRevision must be a positive integer",
        ));
    }
    Ok(())
}

fn validate_type_set<'a>(types: impl Iterator<Item = (i64, &'a str)>, label: &str) -> Result<()> {
    let mut ids = std::collections::HashSet::new();
    let mut names = std::collections::HashSet::new();

    for (id, name) in types {
        if !ids.insert(id) {
            return Err(ProtocolError::new(format!("Duplicate {label} id {id}")));
        }
        if !names.insert(name.to_lowercase()) {
            return Err(ProtocolError::new(format!("Duplicate {label} name {name}")));
        }
    }
    Ok(())
}

fn validate_fields(owner: &str, fields: &[FieldDef], refs: RefTargets<'_>) -> Result<()> {
    let mut ids = std::collections::HashSet::new();
    let mut names = std::collections::HashSet::new();

    for field in fields {
        if !ids.insert(field.id) {
            return Err(ProtocolError::new(format!(
                "Duplicate field id {} in {owner}",
                field.id
            )));
        }
        if !names.insert(field.name.to_lowercase()) {
            return Err(ProtocolError::new(format!(
                "Duplicate field name {owner}.{}",
                field.name
            )));
        }

        // TS guards with truthiness (`field.ref && ...`), so an empty-string
        // ref skips the unknown-target check entirely.
        if field.kind == FieldKind::Ref
            && let Some(target) = &field.ref_
            && !target.is_empty()
            && !refs.object_names.contains(&target.as_str())
            && !refs.blob_names.contains(&target.as_str())
        {
            return Err(ProtocolError::new(format!(
                "Unknown ref target {target} in {owner}.{}",
                field.name
            )));
        }

        if field.kind == FieldKind::Enum && field.enum_values.as_ref().is_none_or(Vec::is_empty) {
            return Err(ProtocolError::new(format!(
                "Enum field {owner}.{} must declare enumValues",
                field.name
            )));
        }

        if let Some(sensitivity) = &field.sensitivity
            && sensitivity.parse::<FieldSensitivity>().is_err()
        {
            return Err(ProtocolError::new(format!(
                "Unknown sensitivity \"{sensitivity}\" for field {owner}.{}",
                field.name
            )));
        }
    }
    Ok(())
}

fn validate_indexes(owner: &str, fields: &[FieldDef], indexes: &[IndexDef]) -> Result<()> {
    validate_type_set(
        indexes.iter().map(|index| (index.id, index.name.as_str())),
        &format!("{owner} index"),
    )?;
    let field_names: Vec<&str> = fields.iter().map(|field| field.name.as_str()).collect();

    for index in indexes {
        for field_name in &index.fields {
            if !field_names.contains(&field_name.as_str()) {
                return Err(ProtocolError::new(format!(
                    "Unknown index field {owner}.{}.{field_name}",
                    index.name
                )));
            }
        }
    }
    Ok(())
}

// -- lookups (objectByName / objectById / ... in TS) -------------------------

pub fn object_by_name<'a>(schema: &'a FrickSchema, name: &str) -> Result<&'a ObjectDef> {
    find_by_name(&schema.objects, "object", name, |t| &t.name)
}

pub fn object_by_id(schema: &FrickSchema, id: i64) -> Result<&ObjectDef> {
    find_by_id(&schema.objects, "object", id, |t| t.id)
}

/// Effective merge policy for an object type; omitted and unknown types both
/// fall back to `lastWriteWins` (`resolveObjectMergePolicy` in TS).
#[must_use]
pub fn resolve_object_merge_policy(schema: &FrickSchema, name: &str) -> FrickObjectMergePolicy {
    schema
        .objects
        .iter()
        .find(|candidate| candidate.name == name)
        .and_then(|def| def.merge_policy)
        .unwrap_or(FrickObjectMergePolicy::LastWriteWins)
}

pub fn stream_by_name<'a>(schema: &'a FrickSchema, name: &str) -> Result<&'a StreamDef> {
    find_by_name(&schema.streams, "stream", name, |t| &t.name)
}

pub fn stream_by_id(schema: &FrickSchema, id: i64) -> Result<&StreamDef> {
    find_by_id(&schema.streams, "stream", id, |t| t.id)
}

pub fn event_by_name<'a>(schema: &'a FrickSchema, name: &str) -> Result<&'a EventDef> {
    find_by_name(&schema.events, "event", name, |t| &t.name)
}

pub fn event_by_id(schema: &FrickSchema, id: i64) -> Result<&EventDef> {
    find_by_id(&schema.events, "event", id, |t| t.id)
}

pub fn presence_by_name<'a>(schema: &'a FrickSchema, name: &str) -> Result<&'a PresenceDef> {
    find_by_name(&schema.presences, "presence", name, |t| &t.name)
}

pub fn presence_by_id(schema: &FrickSchema, id: i64) -> Result<&PresenceDef> {
    find_by_id(&schema.presences, "presence", id, |t| t.id)
}

pub fn signal_by_name<'a>(schema: &'a FrickSchema, name: &str) -> Result<&'a SignalDef> {
    find_by_name(&schema.signals, "signal", name, |t| &t.name)
}

pub fn signal_by_id(schema: &FrickSchema, id: i64) -> Result<&SignalDef> {
    find_by_id(&schema.signals, "signal", id, |t| t.id)
}

pub fn blob_by_name<'a>(schema: &'a FrickSchema, name: &str) -> Result<&'a BlobDef> {
    find_by_name(&schema.blobs, "blob", name, |t| &t.name)
}

pub fn job_by_name<'a>(schema: &'a FrickSchema, name: &str) -> Result<&'a JobDef> {
    find_by_name(&schema.jobs, "job", name, |t| &t.name)
}

pub fn projection_by_name<'a>(schema: &'a FrickSchema, name: &str) -> Result<&'a ProjectionDef> {
    find_by_name(&schema.projections, "projection", name, |t| &t.name)
}

pub fn field_by_name<'a>(fields: &'a [FieldDef], name: &str) -> Result<&'a FieldDef> {
    fields
        .iter()
        .find(|candidate| candidate.name == name)
        .ok_or_else(|| ProtocolError::new(format!("Unknown field {name}")))
}

pub fn field_by_id(fields: &[FieldDef], id: i64) -> Result<&FieldDef> {
    fields
        .iter()
        .find(|candidate| candidate.id == id)
        .ok_or_else(|| ProtocolError::new(format!("Unknown field id {id}")))
}

/// A declared object field that holds a blob id (`BlobRefField` in TS) —
/// the authoritative reference set for orphaned-blob GC. Same caveat as TS:
/// only *declared* `ref` fields are enumerated; blob ids stashed in untyped
/// `string`/`json` fields are invisible here, so GC built on this must stay
/// conservative.
#[derive(Debug, Clone, PartialEq)]
pub struct BlobRefField<'a> {
    pub object_name: &'a str,
    pub field: &'a FieldDef,
    pub blob_name: &'a str,
}

#[must_use]
pub fn blob_ref_fields(schema: &FrickSchema) -> Vec<BlobRefField<'_>> {
    let blob_names: Vec<&str> = schema.blobs.iter().map(|blob| blob.name.as_str()).collect();
    let mut result = Vec::new();
    for object in &schema.objects {
        for field in &object.fields {
            if field.kind == FieldKind::Ref
                && let Some(target) = &field.ref_
                && blob_names.contains(&target.as_str())
            {
                result.push(BlobRefField {
                    object_name: &object.name,
                    field,
                    blob_name: target,
                });
            }
        }
    }
    result
}

fn find_by_name<'a, T>(
    types: &'a [T],
    label: &str,
    name: &str,
    get_name: impl Fn(&T) -> &String,
) -> Result<&'a T> {
    types
        .iter()
        .find(|candidate| get_name(candidate) == name)
        .ok_or_else(|| ProtocolError::new(format!("Unknown {label}: {name}")))
}

fn find_by_id<'a, T>(
    types: &'a [T],
    label: &str,
    id: i64,
    get_id: impl Fn(&T) -> i64,
) -> Result<&'a T> {
    types
        .iter()
        .find(|candidate| get_id(candidate) == id)
        .ok_or_else(|| ProtocolError::new(format!("Unknown {label} id: {id}")))
}
