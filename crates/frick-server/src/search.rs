//! The search index registry + projector (FR-245, map 03 §13), ported from
//! `apps/server/src/search/*` (the registry, the reserved source-field
//! injection/strip helpers, and the store-write projector wiring in
//! `apps/server/src/server.ts`).
//!
//! An app registers a [`FrickSearchIndexDefinition`] over a source primitive
//! (an object type, a stream type, or a projection). On every successful
//! store write the [`SearchRegistry`] matches the event against each index's
//! [`SearchSource`], runs the index's `project` over the written value, and
//! emits the [`SearchOp`]s the store applies to its FTS tables. The reserved
//! `__frickSource*` fields are injected into every indexed doc here, at index
//! time, so the server can post-filter hits by their source record (and strip
//! the reserved keys) before returning them to a non-admin caller.
//!
//! ## What this module owns
//!
//! - [`SearchRegistry`] (TS `createFrickSearchIndexRegistry`): register / list
//!   / [`project_event`](SearchRegistry::project_event).
//! - The [`SearchSource`] / [`SearchDoc`] / [`FrickSearchIndexDefinition`]
//!   model and the reserved source-field constants + helpers
//!   ([`is_reserved_search_field`], [`strip_search_source_fields`]).
//! - The [`FrickStoreWriteEvent`] → [`SearchOp`] projector
//!   ([`SearchRegistry::project_event`]) the boot path installs on the store
//!   via `store.set_search_projector`.
//!
//! ## Determinism
//!
//! The registry holds no clock. `project_event` is pure (the store applies the
//! returned ops itself; the projector must never re-enter the store). Search
//! rows have no `created_at`, so no time enters here.

use std::sync::{Arc, Mutex};

use frick_protocol::Value;
use frick_store::{FrickStoreWriteEvent, SearchOp};
use indexmap::IndexMap;
use serde_json::{Map as JsonMap, Value as JsonValue};

use crate::error::ServerError;

/// Default `POST /search` page size when the caller omits `limit`
/// (`DEFAULT_SEARCH_LIMIT`, map 03 §13.1). Re-exported from the store so the
/// route and the adapter agree.
pub use frick_store::DEFAULT_SEARCH_LIMIT;
/// Hard cap on the `POST /search` page size (`MAX_SEARCH_LIMIT`, map 03 §13.1).
pub use frick_store::MAX_SEARCH_LIMIT;

/// The reserved source-field prefix (`search/source-fields.ts`). Any field key
/// starting with this is framework-owned: injected at index time and stripped
/// from hits before they leave the server.
pub const SOURCE_FIELD_PREFIX: &str = "__frickSource";
/// `__frickSourceKind` — the source kind (`object` / `stream` / `projection`).
pub const SOURCE_KIND_FIELD: &str = "__frickSourceKind";
/// `__frickSourceType` — the source object/stream type or projection name.
pub const SOURCE_TYPE_FIELD: &str = "__frickSourceType";
/// `__frickSourceId` — the source object/stream/projection record id.
pub const SOURCE_ID_FIELD: &str = "__frickSourceId";
/// `__frickSourceEventId` — the source stream event id (stream sources only).
pub const SOURCE_EVENT_ID_FIELD: &str = "__frickSourceEventId";

/// Whether `key` is a reserved framework source field (`isReservedSearchField`,
/// `search/source-fields.ts`): the route rejects these in caller-supplied
/// filters and strips them from hits.
#[must_use]
pub fn is_reserved_search_field(key: &str) -> bool {
    key.starts_with(SOURCE_FIELD_PREFIX)
}

/// Drop every reserved `__frickSource*` field from a hit's `fields`
/// (`stripSearchSourceFields`, `search/source-fields.ts`). The server calls
/// this on each hit before responding.
#[must_use]
pub fn strip_search_source_fields(
    fields: &JsonMap<String, JsonValue>,
) -> JsonMap<String, JsonValue> {
    fields
        .iter()
        .filter(|(key, _)| !is_reserved_search_field(key))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

// ---- §13.1 source / doc model ------------------------------------------------

/// The source primitive an index ingests from (`FrickSearchIndexSource`,
/// `search/types.ts`). Only `Object` and `Stream` are driven by the store
/// write funnel; `Projection` is registrable (for parity + the inspect report)
/// but its writes are not yet routed here (projection deltas don't flow through
/// the store write listener), so a projection-sourced index simply never
/// indexes — matching the TS, whose projection projector is a later wiring.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SearchSource {
    /// An object type: matches `objectUpsert` / `objectDelete` by type.
    Object {
        /// The object type name this source ingests.
        type_name: String,
    },
    /// A stream type: matches `streamAppend` by stream type.
    Stream {
        /// The stream type name this source ingests.
        type_name: String,
    },
    /// A projection by name. Registrable but not store-driven (see the enum
    /// note); included so `GET /_frick/inspect/search` reports it.
    Projection {
        /// The projection name this source ingests.
        name: String,
    },
}

impl SearchSource {
    /// The wire label used in inspection (`"object"` / `"stream"` /
    /// `"projection"`).
    #[must_use]
    pub fn kind_str(&self) -> &'static str {
        match self {
            Self::Object { .. } => "object",
            Self::Stream { .. } => "stream",
            Self::Projection { .. } => "projection",
        }
    }

    /// The source's `type` (object/stream) or `name` (projection) — the value
    /// surfaced as `source.type`/`source.name` in the inspect report.
    #[must_use]
    pub fn type_or_name(&self) -> &str {
        match self {
            Self::Object { type_name } | Self::Stream { type_name } => type_name,
            Self::Projection { name } => name,
        }
    }
}

/// A document projected into an index (`FrickSearchDoc`, `search/types.ts`).
/// `fields` carries app-supplied filterable values plus (after the registry
/// injects them) the reserved `__frickSource*` keys.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SearchDoc {
    /// Stable id for the indexed document (the source record id by default).
    pub doc_id: String,
    /// Already-flattened searchable text.
    pub text: String,
    /// Structured, filterable fields (string / number values).
    pub fields: JsonMap<String, JsonValue>,
}

impl SearchDoc {
    /// A doc with `doc_id` + `text` and no app fields.
    #[must_use]
    pub fn new(doc_id: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            doc_id: doc_id.into(),
            text: text.into(),
            fields: JsonMap::new(),
        }
    }
}

/// An app-provided projector for one index: maps a source value (the object /
/// stream-event value, as the protocol [`Value`]) to a [`SearchDoc`], or `None`
/// to skip indexing that write (`FrickSearchIndexDefinition.project`). `Arc`ed
/// and `Send + Sync` so the registry can hold it behind the shared lock and the
/// store-write projector can run it.
pub type SearchProject = Arc<dyn Fn(&Value) -> Option<SearchDoc> + Send + Sync>;

/// A registered search index (`FrickSearchIndexDefinition`, `search/types.ts`).
pub struct FrickSearchIndexDefinition {
    /// Stable identifier, e.g. `"notes"`.
    pub name: String,
    /// The source primitive this index ingests from.
    pub source: SearchSource,
    /// Project a source value into an index doc, or `None` to skip it.
    pub project: SearchProject,
}

impl FrickSearchIndexDefinition {
    /// Construct an index definition.
    #[must_use]
    pub fn new(name: impl Into<String>, source: SearchSource, project: SearchProject) -> Self {
        Self {
            name: name.into(),
            source,
            project,
        }
    }
}

/// A registered index's `{name, source}` for the inspect report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchIndexDescriptor {
    /// The index name.
    pub name: String,
    /// The declared source.
    pub source: SearchSource,
}

// ---- §13.1 registry ----------------------------------------------------------

/// The locked interior of the registry.
struct RegistryInner {
    /// Registration-ordered index names (drives `index_names` + descriptor
    /// iteration order).
    order: Vec<String>,
    /// Indexes by name (also the duplicate-name guard).
    by_name: IndexMap<String, FrickSearchIndexDefinition>,
}

/// The search index registry (`createFrickSearchIndexRegistry`,
/// `search/types.ts`).
///
/// Cheaply cloneable: an `Arc` around the locked interior so the store-write
/// projector closure, the `/search` route, and the inspect report all share
/// one registry — exactly parallel to [`crate::projections::ProjectionRegistry`].
#[derive(Clone)]
pub struct SearchRegistry {
    inner: Arc<Mutex<RegistryInner>>,
}

impl Default for SearchRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl SearchRegistry {
    /// An empty registry.
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RegistryInner {
                order: Vec::new(),
                by_name: IndexMap::new(),
            })),
        }
    }

    /// Register an index. Preserves registration order. A duplicate name is
    /// rejected with the TS message `Search index "<name>" is already
    /// registered` as a [`ServerError::BadRequest`] (boot maps this to a config
    /// failure), mirroring [`ProjectionRegistry::register`].
    ///
    /// [`ProjectionRegistry::register`]: crate::projections::ProjectionRegistry::register
    ///
    /// # Errors
    /// Returns [`ServerError::BadRequest`] when `definition.name` is already
    /// registered.
    pub fn register(&self, definition: FrickSearchIndexDefinition) -> Result<(), ServerError> {
        let mut inner = self.lock();
        if inner.by_name.contains_key(&definition.name) {
            return Err(ServerError::BadRequest {
                message: format!("Search index \"{}\" is already registered", definition.name),
            });
        }
        inner.order.push(definition.name.clone());
        inner.by_name.insert(definition.name.clone(), definition);
        Ok(())
    }

    /// The registered index names, in registration order (surfaced in the
    /// `/_frick/inspect/search` report).
    #[must_use]
    pub fn index_names(&self) -> Vec<String> {
        self.lock().order.clone()
    }

    /// Whether `name` is registered (`get(name).is_some()`).
    #[must_use]
    pub fn contains(&self, name: &str) -> bool {
        self.lock().by_name.contains_key(name)
    }

    /// The declared source for `name`, or `None` when unregistered. The route
    /// uses this to drive the per-hit visibility post-filter by source kind.
    #[must_use]
    pub fn source_of(&self, name: &str) -> Option<SearchSource> {
        self.lock().by_name.get(name).map(|def| def.source.clone())
    }

    /// The `(name, source)` descriptors for the inspect report, in registration
    /// order.
    #[must_use]
    pub fn descriptors(&self) -> Vec<SearchIndexDescriptor> {
        let inner = self.lock();
        inner
            .order
            .iter()
            .filter_map(|name| inner.by_name.get(name))
            .map(|def| SearchIndexDescriptor {
                name: def.name.clone(),
                source: def.source.clone(),
            })
            .collect()
    }

    /// Map one store-write event to the [`SearchOp`]s the matching indexes want
    /// applied (the store-write projector, installed via
    /// `store.set_search_projector`). For each index whose [`SearchSource`]
    /// matches the event:
    ///
    /// - `objectUpsert` / `streamAppend`: run `project(value)`; on `Some(doc)`
    ///   emit [`SearchOp::Upsert`] with the reserved `__frickSource*` fields
    ///   injected into `doc.fields`; on `None` emit [`SearchOp::Delete`] (the
    ///   row no longer qualifies for the index).
    /// - `objectDelete`: emit [`SearchOp::Delete`] (no `project` runs — the
    ///   value is gone).
    ///
    /// The `doc_id` defaults to the stable source record id (the object id /
    /// stream id / projection key) but a `project` may override it via
    /// `doc.doc_id`. This function is pure: the store applies the ops itself.
    #[must_use]
    pub fn project_event(&self, event: &FrickStoreWriteEvent) -> Vec<SearchOp> {
        // Collect the matching `(name, source, project)` tuples under the lock,
        // then release it before running any `project` (an app projector must
        // not hold the registry mutex, and the store already guards re-entrancy).
        // The source kind already determined the match, so only the name + the
        // projector are needed downstream.
        let matching: Vec<(String, SearchProject)> = {
            let inner = self.lock();
            inner
                .order
                .iter()
                .filter_map(|name| inner.by_name.get(name))
                .filter(|def| source_matches(&def.source, event))
                .map(|def| (def.name.clone(), Arc::clone(&def.project)))
                .collect()
        };

        let mut ops = Vec::new();
        for (name, project) in matching {
            match event {
                FrickStoreWriteEvent::ObjectUpsert {
                    object_type,
                    object_id,
                    object,
                    ..
                } => {
                    ops.push(project_value_to_op(
                        &name,
                        &project,
                        object,
                        object_id,
                        &SourceFields::object(object_type, object_id),
                    ));
                }
                FrickStoreWriteEvent::StreamAppend { event: stored, .. } => {
                    let value = stored_event_to_value(stored);
                    let default_id = stored.event.event_id.clone();
                    ops.push(project_value_to_op(
                        &name,
                        &project,
                        &value,
                        &default_id,
                        &SourceFields::stream(
                            &stored.event.stream,
                            &stored.event.stream_id,
                            &stored.event.event_id,
                        ),
                    ));
                }
                // An object delete removes the indexed doc keyed by the object
                // id (the default doc id the upsert path used).
                FrickStoreWriteEvent::ObjectDelete { object_id, .. } => {
                    ops.push(SearchOp::Delete {
                        index: name.clone(),
                        doc_id: object_id.clone(),
                    });
                }
            }
        }
        ops
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, RegistryInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Run an index's `project` over `value`; on `Some(doc)` build an
/// [`SearchOp::Upsert`] with the reserved source fields injected, else an
/// [`SearchOp::Delete`] keyed by `default_doc_id`.
fn project_value_to_op(
    index: &str,
    project: &SearchProject,
    value: &Value,
    default_doc_id: &str,
    source_fields: &SourceFields<'_>,
) -> SearchOp {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| project(value))) {
        Ok(Some(doc)) => {
            let doc_id = if doc.doc_id.is_empty() {
                default_doc_id.to_string()
            } else {
                doc.doc_id
            };
            let mut fields = doc.fields;
            source_fields.inject(&mut fields);
            SearchOp::Upsert {
                index: index.to_string(),
                doc_id,
                text: doc.text,
                fields,
            }
        }
        Ok(None) => SearchOp::Delete {
            index: index.to_string(),
            doc_id: default_doc_id.to_string(),
        },
        Err(_) => {
            tracing::warn!(
                target: "frick.search.project_failed",
                index,
                "search index project panicked",
            );
            // A panicking projector deletes the doc rather than failing the
            // write (the store swallows search failures too).
            SearchOp::Delete {
                index: index.to_string(),
                doc_id: default_doc_id.to_string(),
            }
        }
    }
}

/// The reserved source fields to inject into a doc at index time
/// (`withSearchSourceFields`, `search/source-fields.ts`).
struct SourceFields<'a> {
    kind: &'static str,
    type_name: &'a str,
    id: &'a str,
    event_id: Option<&'a str>,
}

impl<'a> SourceFields<'a> {
    fn object(type_name: &'a str, id: &'a str) -> Self {
        Self {
            kind: "object",
            type_name,
            id,
            event_id: None,
        }
    }

    fn stream(type_name: &'a str, id: &'a str, event_id: &'a str) -> Self {
        Self {
            kind: "stream",
            type_name,
            id,
            event_id: Some(event_id),
        }
    }

    /// Inject `__frickSource*` keys into `fields`, overwriting any caller-set
    /// values (the framework owns these keys).
    fn inject(&self, fields: &mut JsonMap<String, JsonValue>) {
        fields.insert(SOURCE_KIND_FIELD.to_string(), JsonValue::from(self.kind));
        fields.insert(
            SOURCE_TYPE_FIELD.to_string(),
            JsonValue::from(self.type_name),
        );
        fields.insert(SOURCE_ID_FIELD.to_string(), JsonValue::from(self.id));
        if let Some(event_id) = self.event_id {
            fields.insert(SOURCE_EVENT_ID_FIELD.to_string(), JsonValue::from(event_id));
        }
    }
}

/// Whether `source` matches `event` (object sources match object writes by
/// type; stream sources match stream appends by stream type; projection
/// sources never match a store write).
fn source_matches(source: &SearchSource, event: &FrickStoreWriteEvent) -> bool {
    match source {
        SearchSource::Object { type_name } => match event {
            FrickStoreWriteEvent::ObjectUpsert { object_type, .. }
            | FrickStoreWriteEvent::ObjectDelete { object_type, .. } => type_name == object_type,
            FrickStoreWriteEvent::StreamAppend { .. } => false,
        },
        SearchSource::Stream { type_name } => match event {
            FrickStoreWriteEvent::StreamAppend { event, .. } => type_name == &event.event.stream,
            FrickStoreWriteEvent::ObjectUpsert { .. }
            | FrickStoreWriteEvent::ObjectDelete { .. } => false,
        },
        SearchSource::Projection { .. } => false,
    }
}

/// Render a stored stream event as the msgpack map a `project` sees as its
/// input value (the same `streamEvent` row shape the projection engine builds,
/// `projections::stored_event_to_value`).
fn stored_event_to_value(stored: &frick_store::stores::stream::StoredEvent) -> Value {
    let event = &stored.event;
    Value::Map(vec![
        (Value::from("stream"), Value::from(event.stream.as_str())),
        (
            Value::from("streamId"),
            Value::from(event.stream_id.as_str()),
        ),
        (Value::from("sequence"), Value::from(event.sequence)),
        (Value::from("eventId"), Value::from(event.event_id.as_str())),
        (Value::from("event"), Value::from(event.event.as_str())),
        (Value::from("payload"), event.payload.clone()),
        (
            Value::from("tenantId"),
            Value::from(stored.tenant_id.as_str()),
        ),
        (Value::from("appId"), Value::from(stored.app_id.as_str())),
    ])
}

#[cfg(test)]
mod tests;
