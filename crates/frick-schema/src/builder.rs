//! The fluent schema-authoring DSL — the Rust counterpart of writing
//! `schema.ts` by hand.
//!
//! TypeScript has no builder: an app schema is a plain object literal typed
//! as `FrickSchema` (see `apps/rangercrm-server/src/schema.ts` and the CLI
//! scaffold template `apps/cli/src/templates/schema.ts.ts`). This module is
//! the public authoring contract for Rust apps. It keeps every decision the
//! TS literal makes explicit — most importantly the numeric ids, which are
//! the wire contract and are **never auto-assigned** — while letting the
//! type system carry the boilerplate.
//!
//! Defaults match the scaffolded template: `protocol: "frick.realtime"`,
//! `protocolVersion: 1`, `compatibility: "greenfield-cutover"`,
//! `schemaVersion: "0.1.0"`, and `schemaRevision` / both minimum revisions
//! `1`. `hash` defaults to the empty string — always set it. It is the
//! hand-authored opaque identity string (nothing computes it; the only
//! operation ever performed on it is equality during the hello handshake),
//! so bump it whenever the schema changes shape.
//!
//! Fields are **optional unless marked [`FieldBuilder::required`]**. Adding
//! an optional field is the only non-breaking field addition (the linter
//! reports `field.optional.added` as `info` but `field.required.added` as
//! `breaking`), so the DSL makes the safe choice the quiet one.
//!
//! [`SchemaBuilder::build`] runs [`frick_protocol::schema::validate_schema`]
//! and surfaces its errors verbatim (same strings as the TS
//! `validateSchema`); [`SchemaBuilder::build_unchecked`] skips validation
//! for tests that need a deliberately invalid schema.
//!
//! # Example
//!
//! The Rust equivalent of a CLI-scaffolded `schema.ts` after growing a
//! first object, stream, and event (`frick scaffold object Task` /
//! `frick scaffold stream TaskStream` in the TS workflow):
//!
//! ```
//! use frick_schema::SchemaBuilder;
//! use frick_schema::builder::field;
//!
//! let schema = SchemaBuilder::new("my-app", "my-app")
//!     .version("0.1.0")
//!     .revision(1)
//!     .hash("my-app-0.1.0")
//!     // objects
//!     .object("Task", 1, |o| {
//!         o.field(field::string("title", 1).required())
//!             .field(field::bool("isDone", 2).required())
//!             .field(field::timestamp("completedAt", 3))
//!             .field(field::enum_("priority", 4, ["low", "medium", "high"]).required())
//!             .index("byTitle", 1, ["title"])
//!     })
//!     // streams
//!     .stream("TaskStream", 1, |s| {
//!         s.key_field(field::ref_("taskId", 1, "Task").required())
//!             .event("TaskCompleted")
//!     })
//!     .event("TaskCompleted", 1, |e| {
//!         e.field(field::id("taskId", 1).required())
//!             .field(field::timestamp("completedAt", 2).required())
//!     })
//!     .build()
//!     .expect("schema validates");
//!
//! assert_eq!(schema.schema_id, "my-app");
//! assert_eq!(schema.protocol, "frick.realtime");
//! assert_eq!(schema.objects[0].fields[2].required, false);
//! ```

use frick_protocol::ProtocolError;
use frick_protocol::schema::{
    BlobDef, EventDef, FieldDef, FieldKind, FieldSensitivity, FrickObjectMergePolicy, FrickSchema,
    IndexDef, JobDef, ObjectDef, PresenceDef, ProjectionDef, SignalDef, StreamDef, validate_schema,
};

/// Free-function constructors for [`FieldBuilder`], one per [`FieldKind`].
///
/// Each takes the field name first and the explicit numeric field id second
/// (ids are the wire contract — the wire never carries field names). Fields
/// start optional; chain [`FieldBuilder::required`] to flip.
///
/// `ref` and `enum` carry their extra payload inline: [`ref_`] takes the
/// target object or blob name, [`enum_`] the ordered value list (order is
/// wire-significant — appending is safe, inserting mid-list is breaking).
pub mod field {
    use super::{FieldBuilder, FieldKind};

    /// A `kind: "id"` field.
    pub fn id(name: impl Into<String>, id: i64) -> FieldBuilder {
        FieldBuilder::new(name, id, FieldKind::Id)
    }

    /// A `kind: "ref"` field pointing at the named object or blob type.
    pub fn ref_(name: impl Into<String>, id: i64, target: impl Into<String>) -> FieldBuilder {
        FieldBuilder::new(name, id, FieldKind::Ref).ref_(target)
    }

    /// A `kind: "string"` field.
    pub fn string(name: impl Into<String>, id: i64) -> FieldBuilder {
        FieldBuilder::new(name, id, FieldKind::String)
    }

    /// A `kind: "bool"` field (the wire string is `"bool"`, not `"boolean"`).
    pub fn bool(name: impl Into<String>, id: i64) -> FieldBuilder {
        FieldBuilder::new(name, id, FieldKind::Bool)
    }

    /// A `kind: "timestamp"` field.
    pub fn timestamp(name: impl Into<String>, id: i64) -> FieldBuilder {
        FieldBuilder::new(name, id, FieldKind::Timestamp)
    }

    /// A `kind: "int"` field.
    pub fn int(name: impl Into<String>, id: i64) -> FieldBuilder {
        FieldBuilder::new(name, id, FieldKind::Int)
    }

    /// A `kind: "bytes"` field.
    pub fn bytes(name: impl Into<String>, id: i64) -> FieldBuilder {
        FieldBuilder::new(name, id, FieldKind::Bytes)
    }

    /// A `kind: "enum"` field with its ordered value list (must be
    /// non-empty to validate).
    pub fn enum_(
        name: impl Into<String>,
        id: i64,
        values: impl IntoIterator<Item = impl Into<String>>,
    ) -> FieldBuilder {
        FieldBuilder::new(name, id, FieldKind::Enum).enum_values(values)
    }

    /// A `kind: "json"` field.
    pub fn json(name: impl Into<String>, id: i64) -> FieldBuilder {
        FieldBuilder::new(name, id, FieldKind::Json)
    }
}

/// Builds one [`FieldDef`]. Construct via the [`field`] helpers (or
/// [`FieldBuilder::new`] as the escape hatch for unusual shapes, e.g. a
/// `ref` field with no target — which `validateSchema` accepts).
#[derive(Debug, Clone)]
#[must_use]
pub struct FieldBuilder {
    def: FieldDef,
}

impl FieldBuilder {
    /// Start a field of an explicit kind. Prefer the [`field`] helpers.
    pub fn new(name: impl Into<String>, id: i64, kind: FieldKind) -> Self {
        Self {
            def: FieldDef {
                id,
                name: name.into(),
                kind,
                required: false,
                ref_: None,
                enum_values: None,
                sensitivity: None,
            },
        }
    }

    /// Mark the field required. Adding a required field to a shipped schema
    /// is a breaking change — new fields should usually stay optional.
    pub fn required(mut self) -> Self {
        self.def.required = true;
        self
    }

    /// Mark the field optional (the default; provided for explicitness).
    pub fn optional(mut self) -> Self {
        self.def.required = false;
        self
    }

    /// Set the `ref` target (an object or blob type name). Only meaningful
    /// for `kind: "ref"` fields — [`field::ref_`] sets it inline.
    pub fn ref_(mut self, target: impl Into<String>) -> Self {
        self.def.ref_ = Some(target.into());
        self
    }

    /// Set the ordered `enumValues` list. Only meaningful for
    /// `kind: "enum"` fields — [`field::enum_`] sets it inline.
    pub fn enum_values(mut self, values: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.def.enum_values = Some(values.into_iter().map(Into::into).collect());
        self
    }

    /// Classify the field's values. Server-only metadata; omitted fields
    /// default to `private` (`DEFAULT_FIELD_SENSITIVITY`).
    pub fn sensitivity(mut self, sensitivity: FieldSensitivity) -> Self {
        self.def.sensitivity = Some(sensitivity.as_str().to_owned());
        self
    }
}

impl From<FieldBuilder> for FieldDef {
    fn from(builder: FieldBuilder) -> Self {
        builder.def
    }
}

/// Builds one [`ObjectDef`] inside [`SchemaBuilder::object`].
#[derive(Debug, Clone)]
#[must_use]
pub struct ObjectBuilder {
    def: ObjectDef,
}

impl ObjectBuilder {
    /// Append a field (declaration order is preserved).
    pub fn field(mut self, field: impl Into<FieldDef>) -> Self {
        self.def.fields.push(field.into());
        self
    }

    /// Append an index over the named declared fields.
    pub fn index(
        mut self,
        name: impl Into<String>,
        id: i64,
        fields: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        self.def.indexes.push(IndexDef {
            id,
            name: name.into(),
            fields: fields.into_iter().map(Into::into).collect(),
        });
        self
    }

    /// Set the merge policy; omitted objects resolve to `lastWriteWins`.
    pub fn merge_policy(mut self, policy: FrickObjectMergePolicy) -> Self {
        self.def.merge_policy = Some(policy);
        self
    }
}

/// Builds one [`StreamDef`] inside [`SchemaBuilder::stream`].
#[derive(Debug, Clone)]
#[must_use]
pub struct StreamBuilder {
    def: StreamDef,
}

impl StreamBuilder {
    /// Append a key field (the stream's partition key shape).
    pub fn key_field(mut self, field: impl Into<FieldDef>) -> Self {
        self.def.key_fields.push(field.into());
        self
    }

    /// Append one event name; must match a declared event.
    pub fn event(mut self, name: impl Into<String>) -> Self {
        self.def.events.push(name.into());
        self
    }

    /// Append several event names in order.
    pub fn events(mut self, names: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.def.events.extend(names.into_iter().map(Into::into));
        self
    }
}

/// Builds one [`EventDef`] inside [`SchemaBuilder::event`].
#[derive(Debug, Clone)]
#[must_use]
pub struct EventBuilder {
    def: EventDef,
}

impl EventBuilder {
    /// Append a payload field.
    pub fn field(mut self, field: impl Into<FieldDef>) -> Self {
        self.def.fields.push(field.into());
        self
    }
}

/// Builds one [`PresenceDef`] inside [`SchemaBuilder::presence`].
#[derive(Debug, Clone)]
#[must_use]
pub struct PresenceBuilder {
    def: PresenceDef,
}

impl PresenceBuilder {
    /// Append a key field.
    pub fn key_field(mut self, field: impl Into<FieldDef>) -> Self {
        self.def.key_fields.push(field.into());
        self
    }

    /// Append a value field.
    pub fn field(mut self, field: impl Into<FieldDef>) -> Self {
        self.def.fields.push(field.into());
        self
    }
}

/// Builds one [`SignalDef`] inside [`SchemaBuilder::signal`].
#[derive(Debug, Clone)]
#[must_use]
pub struct SignalBuilder {
    def: SignalDef,
}

impl SignalBuilder {
    /// Append a key field.
    pub fn key_field(mut self, field: impl Into<FieldDef>) -> Self {
        self.def.key_fields.push(field.into());
        self
    }

    /// Append a payload field.
    pub fn field(mut self, field: impl Into<FieldDef>) -> Self {
        self.def.fields.push(field.into());
        self
    }
}

/// Builds one [`BlobDef`] inside [`SchemaBuilder::blob`].
#[derive(Debug, Clone)]
#[must_use]
pub struct BlobBuilder {
    def: BlobDef,
}

impl BlobBuilder {
    /// Append a metadata field (`metadataFields` in the AST).
    pub fn metadata_field(mut self, field: impl Into<FieldDef>) -> Self {
        self.def.metadata_fields.push(field.into());
        self
    }
}

/// Builds one [`JobDef`] inside [`SchemaBuilder::job`].
#[derive(Debug, Clone)]
#[must_use]
pub struct JobBuilder {
    def: JobDef,
}

impl JobBuilder {
    /// Append a payload field.
    pub fn field(mut self, field: impl Into<FieldDef>) -> Self {
        self.def.fields.push(field.into());
        self
    }
}

/// Builds one [`ProjectionDef`] inside [`SchemaBuilder::projection`].
#[derive(Debug, Clone)]
#[must_use]
pub struct ProjectionBuilder {
    def: ProjectionDef,
}

impl ProjectionBuilder {
    /// Append a row field.
    pub fn field(mut self, field: impl Into<FieldDef>) -> Self {
        self.def.fields.push(field.into());
        self
    }

    /// Append an index over the named declared fields.
    pub fn index(
        mut self,
        name: impl Into<String>,
        id: i64,
        fields: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        self.def.indexes.push(IndexDef {
            id,
            name: name.into(),
            fields: fields.into_iter().map(Into::into).collect(),
        });
        self
    }
}

/// The fluent entry point: identity setters plus one nested-builder method
/// per schema collection. Collections are emitted in call order, matching
/// how TS literals preserve authoring order. See the [module docs](self)
/// for defaults and a full example.
#[derive(Debug, Clone)]
#[must_use]
pub struct SchemaBuilder {
    schema: FrickSchema,
}

impl SchemaBuilder {
    /// Start a schema named `name` with wire identity `schema_id`, with all
    /// scaffold defaults applied (see the [module docs](self)).
    pub fn new(name: impl Into<String>, schema_id: impl Into<String>) -> Self {
        Self {
            schema: FrickSchema {
                name: name.into(),
                schema_id: schema_id.into(),
                schema_version: "0.1.0".into(),
                schema_revision: 1,
                minimum_client_revision: 1,
                minimum_server_revision: 1,
                protocol: "frick.realtime".into(),
                protocol_version: 1,
                compatibility: "greenfield-cutover".into(),
                hash: String::new(),
                objects: vec![],
                streams: vec![],
                events: vec![],
                presences: vec![],
                signals: vec![],
                blobs: vec![],
                jobs: vec![],
                projections: vec![],
            },
        }
    }

    /// Set `schemaVersion` (default `"0.1.0"`).
    pub fn version(mut self, version: impl Into<String>) -> Self {
        self.schema.schema_version = version.into();
        self
    }

    /// Set `schemaRevision`, the wire-contract generation counter (default
    /// `1`; must stay a positive integer).
    pub fn revision(mut self, revision: i64) -> Self {
        self.schema.schema_revision = revision;
        self
    }

    /// Set `minimumClientRevision` (default `1`).
    pub fn minimum_client_revision(mut self, revision: i64) -> Self {
        self.schema.minimum_client_revision = revision;
        self
    }

    /// Set `minimumServerRevision` (default `1`).
    pub fn minimum_server_revision(mut self, revision: i64) -> Self {
        self.schema.minimum_server_revision = revision;
        self
    }

    /// Override `protocol`. Anything but the default `"frick.realtime"`
    /// fails [`Self::build`] — exposed for negative tests via
    /// [`Self::build_unchecked`].
    pub fn protocol(mut self, protocol: impl Into<String>) -> Self {
        self.schema.protocol = protocol.into();
        self
    }

    /// Set `protocolVersion` (default `1`; not validated).
    pub fn protocol_version(mut self, version: i64) -> Self {
        self.schema.protocol_version = version;
        self
    }

    /// Override `compatibility`. Anything but the default
    /// `"greenfield-cutover"` fails [`Self::build`] — exposed for negative
    /// tests via [`Self::build_unchecked`].
    pub fn compatibility(mut self, compatibility: impl Into<String>) -> Self {
        self.schema.compatibility = compatibility.into();
        self
    }

    /// Set the hand-authored opaque identity `hash` (default empty —
    /// always set it; equality on this string gates the legacy handshake).
    pub fn hash(mut self, hash: impl Into<String>) -> Self {
        self.schema.hash = hash.into();
        self
    }

    /// Declare an object type with an explicit numeric id.
    pub fn object(
        mut self,
        name: impl Into<String>,
        id: i64,
        build: impl FnOnce(ObjectBuilder) -> ObjectBuilder,
    ) -> Self {
        let builder = ObjectBuilder {
            def: ObjectDef {
                id,
                name: name.into(),
                fields: vec![],
                indexes: vec![],
                merge_policy: None,
            },
        };
        self.schema.objects.push(build(builder).def);
        self
    }

    /// Declare a stream type with an explicit numeric id.
    pub fn stream(
        mut self,
        name: impl Into<String>,
        id: i64,
        build: impl FnOnce(StreamBuilder) -> StreamBuilder,
    ) -> Self {
        let builder = StreamBuilder {
            def: StreamDef {
                id,
                name: name.into(),
                key_fields: vec![],
                events: vec![],
            },
        };
        self.schema.streams.push(build(builder).def);
        self
    }

    /// Declare an event type with an explicit numeric id.
    pub fn event(
        mut self,
        name: impl Into<String>,
        id: i64,
        build: impl FnOnce(EventBuilder) -> EventBuilder,
    ) -> Self {
        let builder = EventBuilder {
            def: EventDef {
                id,
                name: name.into(),
                fields: vec![],
            },
        };
        self.schema.events.push(build(builder).def);
        self
    }

    /// Declare a presence type with an explicit numeric id and TTL in
    /// milliseconds (e.g. `5000` for a typing indicator).
    pub fn presence(
        mut self,
        name: impl Into<String>,
        id: i64,
        ttl_ms: i64,
        build: impl FnOnce(PresenceBuilder) -> PresenceBuilder,
    ) -> Self {
        let builder = PresenceBuilder {
            def: PresenceDef {
                id,
                name: name.into(),
                key_fields: vec![],
                fields: vec![],
                ttl_ms,
            },
        };
        self.schema.presences.push(build(builder).def);
        self
    }

    /// Declare a signal type with an explicit numeric id and TTL in
    /// milliseconds (e.g. `30000` for WebRTC signaling).
    pub fn signal(
        mut self,
        name: impl Into<String>,
        id: i64,
        ttl_ms: i64,
        build: impl FnOnce(SignalBuilder) -> SignalBuilder,
    ) -> Self {
        let builder = SignalBuilder {
            def: SignalDef {
                id,
                name: name.into(),
                key_fields: vec![],
                fields: vec![],
                ttl_ms,
            },
        };
        self.schema.signals.push(build(builder).def);
        self
    }

    /// Declare a blob type with an explicit numeric id.
    pub fn blob(
        mut self,
        name: impl Into<String>,
        id: i64,
        build: impl FnOnce(BlobBuilder) -> BlobBuilder,
    ) -> Self {
        let builder = BlobBuilder {
            def: BlobDef {
                id,
                name: name.into(),
                metadata_fields: vec![],
            },
        };
        self.schema.blobs.push(build(builder).def);
        self
    }

    /// Declare a job type with an explicit numeric id.
    pub fn job(
        mut self,
        name: impl Into<String>,
        id: i64,
        build: impl FnOnce(JobBuilder) -> JobBuilder,
    ) -> Self {
        let builder = JobBuilder {
            def: JobDef {
                id,
                name: name.into(),
                fields: vec![],
            },
        };
        self.schema.jobs.push(build(builder).def);
        self
    }

    /// Declare a projection with an explicit numeric id, sourced from a
    /// declared stream or object name.
    pub fn projection(
        mut self,
        name: impl Into<String>,
        id: i64,
        source: impl Into<String>,
        build: impl FnOnce(ProjectionBuilder) -> ProjectionBuilder,
    ) -> Self {
        let builder = ProjectionBuilder {
            def: ProjectionDef {
                id,
                name: name.into(),
                source: source.into(),
                fields: vec![],
                indexes: vec![],
            },
        };
        self.schema.projections.push(build(builder).def);
        self
    }

    /// Validate and return the schema. Runs
    /// [`frick_protocol::schema::validate_schema`], so every TS
    /// `validateSchema` rule applies with the exact same error strings.
    ///
    /// # Errors
    ///
    /// Returns the first validation failure, e.g. `Duplicate object id 1`
    /// or `Unknown ref target Nope in User.avatarBlobId`.
    pub fn build(self) -> Result<FrickSchema, ProtocolError> {
        validate_schema(&self.schema)?;
        Ok(self.schema)
    }

    /// Return the schema without validating — for negative tests and lint
    /// fixtures that need an intentionally invalid snapshot.
    #[must_use]
    pub fn build_unchecked(self) -> FrickSchema {
        self.schema
    }
}

#[cfg(test)]
mod tests {
    use super::{SchemaBuilder, field};
    use frick_protocol::schema::{FieldKind, FieldSensitivity, FrickObjectMergePolicy};

    #[test]
    fn defaults_match_the_scaffold_template() {
        let schema = SchemaBuilder::new("my-app", "my-app-id").build_unchecked();
        assert_eq!(schema.name, "my-app");
        assert_eq!(schema.schema_id, "my-app-id");
        assert_eq!(schema.schema_version, "0.1.0");
        assert_eq!(schema.schema_revision, 1);
        assert_eq!(schema.minimum_client_revision, 1);
        assert_eq!(schema.minimum_server_revision, 1);
        assert_eq!(schema.protocol, "frick.realtime");
        assert_eq!(schema.protocol_version, 1);
        assert_eq!(schema.compatibility, "greenfield-cutover");
        assert_eq!(schema.hash, "");
        assert!(schema.objects.is_empty());
        assert!(schema.projections.is_empty());
    }

    #[test]
    fn an_empty_schema_with_identity_builds() {
        let schema = SchemaBuilder::new("app", "app")
            .hash("app-0.1.0")
            .build()
            .expect("empty schema validates");
        assert_eq!(schema.hash, "app-0.1.0");
    }

    #[test]
    fn field_helpers_carry_kind_payload_and_optionality() {
        let def: frick_protocol::schema::FieldDef = field::enum_("status", 6, ["pending", "done"])
            .required()
            .sensitivity(FieldSensitivity::Public)
            .into();
        assert_eq!(def.id, 6);
        assert_eq!(def.name, "status");
        assert_eq!(def.kind, FieldKind::Enum);
        assert!(def.required);
        assert_eq!(
            def.enum_values.as_deref(),
            Some(&["pending".to_owned(), "done".to_owned()][..])
        );
        assert_eq!(def.sensitivity.as_deref(), Some("public"));

        let reference: frick_protocol::schema::FieldDef = field::ref_("ownerId", 2, "User").into();
        assert_eq!(reference.kind, FieldKind::Ref);
        assert_eq!(reference.ref_.as_deref(), Some("User"));
        assert!(!reference.required, "fields default to optional");
        assert!(reference.sensitivity.is_none());
    }

    #[test]
    fn build_surfaces_validate_schema_errors_verbatim() {
        let err = SchemaBuilder::new("app", "app")
            .object("Thing", 1, |o| {
                o.field(field::enum_("state", 1, Vec::<String>::new()))
            })
            .build()
            .expect_err("empty enumValues must fail");
        assert_eq!(
            err.to_string(),
            "Enum field Thing.state must declare enumValues"
        );

        let err = SchemaBuilder::new("app", "app")
            .object("Thing", 1, |o| o.field(field::ref_("ownerId", 1, "Nope")))
            .build()
            .expect_err("unknown ref target must fail");
        assert_eq!(err.to_string(), "Unknown ref target Nope in Thing.ownerId");
    }

    #[test]
    fn build_unchecked_skips_validation() {
        let schema = SchemaBuilder::new("app", "app")
            .protocol("not.frick")
            .compatibility("time-travel")
            .build_unchecked();
        assert_eq!(schema.protocol, "not.frick");
        assert_eq!(schema.compatibility, "time-travel");
    }

    #[test]
    fn collections_preserve_call_order_and_merge_policy() {
        let schema = SchemaBuilder::new("app", "app")
            .object("B", 2, |o| {
                o.field(field::string("name", 1).required())
                    .merge_policy(FrickObjectMergePolicy::VersionPrecondition)
            })
            .object("A", 1, |o| o.field(field::string("name", 1)))
            .build()
            .expect("schema validates");
        assert_eq!(schema.objects[0].name, "B");
        assert_eq!(schema.objects[1].name, "A");
        assert_eq!(
            schema.objects[0].merge_policy,
            Some(FrickObjectMergePolicy::VersionPrecondition)
        );
        assert_eq!(schema.objects[1].merge_policy, None);
    }
}
