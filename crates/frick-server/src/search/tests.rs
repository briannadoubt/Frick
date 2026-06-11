//! Unit tests for the search registry + projector (FR-245). A standalone
//! [`SearchRegistry`] driven by synthesized [`FrickStoreWriteEvent`]s — the
//! foundation schema ships no indexes.

use std::sync::Arc;

use frick_protocol::StreamEventInput;
use frick_protocol::Value;
use frick_store::stores::stream::StoredEvent;
use frick_store::{FrickStoreWriteEvent, SearchOp};

use super::*;

/// A `widget` object → doc projector: indexes the `body` string field as text,
/// carries `room` through as a filter field, and skips widgets whose `body` is
/// `"skip"` (returns `None` → the row is deleted from the index).
fn widget_index() -> FrickSearchIndexDefinition {
    FrickSearchIndexDefinition::new(
        "widgets",
        SearchSource::Object {
            type_name: "widget".to_string(),
        },
        Arc::new(|value: &Value| {
            let body = map_str(value, "body")?;
            if body == "skip" {
                return None;
            }
            let mut doc = SearchDoc::new(map_str(value, "id").unwrap_or_default(), body);
            if let Some(room) = map_str(value, "room") {
                doc.fields
                    .insert("room".to_string(), serde_json::Value::from(room));
            }
            Some(doc)
        }),
    )
}

/// Pull a string field out of an rmpv map value.
fn map_str(value: &Value, key: &str) -> Option<String> {
    let Value::Map(entries) = value else {
        return None;
    };
    entries
        .iter()
        .find(|(k, _)| k.as_str() == Some(key))
        .and_then(|(_, v)| v.as_str())
        .map(str::to_string)
}

fn widget_upsert(id: &str, body: &str) -> FrickStoreWriteEvent {
    FrickStoreWriteEvent::ObjectUpsert {
        tenant_id: "_default".to_string(),
        app_id: "_default".to_string(),
        object_type: "widget".to_string(),
        object_id: id.to_string(),
        object: Value::Map(vec![
            (Value::from("id"), Value::from(id)),
            (Value::from("body"), Value::from(body)),
            (Value::from("room"), Value::from("r1")),
        ]),
    }
}

#[test]
fn register_rejects_duplicate_names() {
    let registry = SearchRegistry::new();
    registry.register(widget_index()).unwrap();
    let err = registry.register(widget_index()).unwrap_err();
    match err {
        crate::error::ServerError::BadRequest { message } => {
            assert!(message.contains("already registered"), "message: {message}");
        }
        other => panic!("expected BadRequest, got {other:?}"),
    }
    assert_eq!(registry.index_names(), vec!["widgets".to_string()]);
}

#[test]
fn project_event_emits_upsert_with_injected_source_fields() {
    let registry = SearchRegistry::new();
    registry.register(widget_index()).unwrap();

    let ops = registry.project_event(&widget_upsert("w1", "hello world"));
    assert_eq!(ops.len(), 1);
    let SearchOp::Upsert {
        index,
        doc_id,
        text,
        fields,
    } = &ops[0]
    else {
        panic!("expected upsert, got {:?}", ops[0]);
    };
    assert_eq!(index, "widgets");
    assert_eq!(doc_id, "w1");
    assert_eq!(text, "hello world");
    // App field carried through.
    assert_eq!(fields.get("room").and_then(|v| v.as_str()), Some("r1"));
    // Reserved source fields injected.
    assert_eq!(
        fields.get(SOURCE_KIND_FIELD).and_then(|v| v.as_str()),
        Some("object")
    );
    assert_eq!(
        fields.get(SOURCE_TYPE_FIELD).and_then(|v| v.as_str()),
        Some("widget")
    );
    assert_eq!(
        fields.get(SOURCE_ID_FIELD).and_then(|v| v.as_str()),
        Some("w1")
    );
    // No event id for an object source.
    assert!(!fields.contains_key(SOURCE_EVENT_ID_FIELD));
}

#[test]
fn project_none_emits_delete() {
    let registry = SearchRegistry::new();
    registry.register(widget_index()).unwrap();
    let ops = registry.project_event(&widget_upsert("w2", "skip"));
    assert_eq!(ops.len(), 1);
    match &ops[0] {
        SearchOp::Delete { index, doc_id } => {
            assert_eq!(index, "widgets");
            assert_eq!(doc_id, "w2");
        }
        other @ SearchOp::Upsert { .. } => panic!("expected delete, got {other:?}"),
    }
}

#[test]
fn object_delete_emits_delete() {
    let registry = SearchRegistry::new();
    registry.register(widget_index()).unwrap();
    let event = FrickStoreWriteEvent::ObjectDelete {
        tenant_id: "_default".to_string(),
        app_id: "_default".to_string(),
        object_type: "widget".to_string(),
        object_id: "w3".to_string(),
    };
    let ops = registry.project_event(&event);
    assert_eq!(ops.len(), 1);
    match &ops[0] {
        SearchOp::Delete { index, doc_id } => {
            assert_eq!(index, "widgets");
            assert_eq!(doc_id, "w3");
        }
        other @ SearchOp::Upsert { .. } => panic!("expected delete, got {other:?}"),
    }
}

#[test]
fn non_matching_type_emits_nothing() {
    let registry = SearchRegistry::new();
    registry.register(widget_index()).unwrap();
    let event = FrickStoreWriteEvent::ObjectUpsert {
        tenant_id: "_default".to_string(),
        app_id: "_default".to_string(),
        object_type: "gadget".to_string(),
        object_id: "g1".to_string(),
        object: Value::Map(vec![(Value::from("body"), Value::from("x"))]),
    };
    assert!(registry.project_event(&event).is_empty());
}

#[test]
fn stream_source_injects_event_id() {
    let registry = SearchRegistry::new();
    registry
        .register(FrickSearchIndexDefinition::new(
            "chat",
            SearchSource::Stream {
                type_name: "Chat".to_string(),
            },
            Arc::new(|value: &Value| {
                let text = map_str(value, "event").unwrap_or_default();
                Some(SearchDoc::new("", text))
            }),
        ))
        .unwrap();

    let stored = StoredEvent {
        tenant_id: "_default".to_string(),
        app_id: "_default".to_string(),
        event: StreamEventInput {
            stream: "Chat".to_string(),
            stream_id: "room-1".to_string(),
            sequence: 1,
            event_id: "evt-1".to_string(),
            event: "message".to_string(),
            payload: Value::Map(vec![(Value::from("text"), Value::from("hi"))]),
        },
    };
    let event = FrickStoreWriteEvent::StreamAppend {
        tenant_id: "_default".to_string(),
        event: stored,
    };
    let ops = registry.project_event(&event);
    assert_eq!(ops.len(), 1);
    let SearchOp::Upsert { doc_id, fields, .. } = &ops[0] else {
        panic!("expected upsert, got {:?}", ops[0]);
    };
    // Default doc id is the event id.
    assert_eq!(doc_id, "evt-1");
    assert_eq!(
        fields.get(SOURCE_KIND_FIELD).and_then(|v| v.as_str()),
        Some("stream")
    );
    assert_eq!(
        fields.get(SOURCE_TYPE_FIELD).and_then(|v| v.as_str()),
        Some("Chat")
    );
    assert_eq!(
        fields.get(SOURCE_ID_FIELD).and_then(|v| v.as_str()),
        Some("room-1")
    );
    assert_eq!(
        fields.get(SOURCE_EVENT_ID_FIELD).and_then(|v| v.as_str()),
        Some("evt-1")
    );
}

#[test]
fn strip_removes_reserved_fields() {
    let mut fields = serde_json::Map::new();
    fields.insert("room".to_string(), serde_json::Value::from("r1"));
    fields.insert(
        SOURCE_KIND_FIELD.to_string(),
        serde_json::Value::from("object"),
    );
    fields.insert(SOURCE_ID_FIELD.to_string(), serde_json::Value::from("w1"));
    let stripped = strip_search_source_fields(&fields);
    assert_eq!(stripped.len(), 1);
    assert_eq!(stripped.get("room").and_then(|v| v.as_str()), Some("r1"));
    assert!(!stripped.contains_key(SOURCE_KIND_FIELD));
}
