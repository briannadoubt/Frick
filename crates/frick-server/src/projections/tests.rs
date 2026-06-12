//! Tests for the projection engine (FR-245). A standalone [`ProjectionRegistry`]
//! with a test handler — the foundation schema ships no projections.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use frick_protocol::StreamEventInput;
use frick_protocol::Value;
use frick_store::FrickStoreWriteEvent;
use frick_store::stores::stream::StoredEvent;

use super::*;

/// A test handler: an object-source counter. Each `widget` upsert increments a
/// per-id counter row keyed by the object id; the row value is `{ count }`.
struct CounterHandler {
    /// Records every apply for assertion (event kind label).
    applied: Arc<Mutex<Vec<String>>>,
    /// Counts per row key, so apply is a real materialization.
    counts: Arc<Mutex<BTreeMap<String, i64>>>,
    /// Whether the test wants `rebuild` support.
    rebuildable: bool,
    /// Whether the test wants `read` support.
    readable: bool,
    /// Bumped on every rebuild call.
    rebuilds: Arc<AtomicUsize>,
}

impl CounterHandler {
    fn new() -> Self {
        Self {
            applied: Arc::new(Mutex::new(Vec::new())),
            counts: Arc::new(Mutex::new(BTreeMap::new())),
            rebuildable: false,
            readable: false,
            rebuilds: Arc::new(AtomicUsize::new(0)),
        }
    }
}

impl FrickProjectionHandler for CounterHandler {
    fn apply(
        &self,
        event: &FrickProjectionWriteEvent,
        _ctx: &FrickProjectionContext,
    ) -> ProjectionApplyResult {
        match event {
            FrickProjectionWriteEvent::ObjectUpsert { object_id, .. } => {
                self.applied
                    .lock()
                    .unwrap()
                    .push("objectUpsert".to_string());
                let mut counts = self.counts.lock().unwrap();
                let next = counts.entry(object_id.clone()).or_insert(0);
                *next += 1;
                ProjectionApplyResult::single(
                    object_id.clone(),
                    Some(Value::Map(vec![(Value::from("count"), Value::from(*next))])),
                )
            }
            _ => ProjectionApplyResult::none(),
        }
    }

    fn rebuild(&self, _ctx: &FrickProjectionContext) {
        self.rebuilds.fetch_add(1, Ordering::SeqCst);
    }

    fn supports_rebuild(&self) -> bool {
        self.rebuildable
    }

    fn read(
        &self,
        _ctx: &FrickProjectionContext,
        query: &BTreeMap<String, String>,
    ) -> Option<Value> {
        if !self.readable {
            return None;
        }
        // Echo back the requested key's count (or 0).
        let key = query.get("key").cloned().unwrap_or_default();
        let count = self.counts.lock().unwrap().get(&key).copied().unwrap_or(0);
        Some(Value::Map(vec![
            (Value::from("key"), Value::from(key.as_str())),
            (Value::from("count"), Value::from(count)),
        ]))
    }
}

fn object_upsert_event(object_id: &str) -> FrickProjectionWriteEvent {
    FrickProjectionWriteEvent::ObjectUpsert {
        tenant_id: "tenant-1".to_string(),
        app_id: DEFAULT_APP_ID.to_string(),
        object_type: "widget".to_string(),
        object_id: object_id.to_string(),
        object: Value::Map(vec![(Value::from("id"), Value::from(object_id))]),
    }
}

fn ctx() -> FrickProjectionContext {
    FrickProjectionContext::new("tenant-1", DEFAULT_APP_ID)
}

fn register_counter(registry: &ProjectionRegistry) {
    registry
        .register(FrickProjection::new(
            "widget-counter",
            vec![FrickProjectionSource::object("widget")],
            Box::new(CounterHandler::new()),
        ))
        .unwrap();
}

#[test]
fn notify_updates_snapshot_and_fires_delta_listener() {
    let registry = ProjectionRegistry::new();
    register_counter(&registry);

    // Capture every delta notice.
    let received: Arc<Mutex<Vec<ProjectionDeltaNotice>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&received);
    registry.set_delta_listener(Some(Box::new(move |notice| {
        sink.lock().unwrap().push(notice.clone());
    })));

    registry.notify(&object_upsert_event("w-1"), &ctx());

    // Snapshot materialized.
    let snapshot = registry.snapshot("widget-counter", "tenant-1");
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0].key, "w-1");
    assert_eq!(
        snapshot[0].value,
        Some(Value::Map(vec![(Value::from("count"), Value::from(1_i64))]))
    );

    // Delta listener got the notice.
    let notices = received.lock().unwrap();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].projection, "widget-counter");
    assert_eq!(notices[0].tenant_id, "tenant-1");
    assert_eq!(notices[0].app_id, DEFAULT_APP_ID);
    assert_eq!(notices[0].changes.len(), 1);
    assert_eq!(notices[0].changes[0].key, "w-1");
}

#[test]
fn snapshot_updates_even_without_listener() {
    let registry = ProjectionRegistry::new();
    register_counter(&registry);
    // No delta listener attached.
    registry.notify(&object_upsert_event("w-1"), &ctx());
    registry.notify(&object_upsert_event("w-1"), &ctx());

    let snapshot = registry.snapshot("widget-counter", "tenant-1");
    assert_eq!(snapshot.len(), 1);
    assert_eq!(
        snapshot[0].value,
        Some(Value::Map(vec![(Value::from("count"), Value::from(2_i64))]))
    );
}

#[test]
fn driver_routes_object_upsert_but_not_object_delete() {
    let registry = ProjectionRegistry::new();
    register_counter(&registry);

    let upsert = FrickStoreWriteEvent::ObjectUpsert {
        tenant_id: "tenant-1".to_string(),
        app_id: DEFAULT_APP_ID.to_string(),
        object_type: "widget".to_string(),
        object_id: "w-1".to_string(),
        object: Value::Map(vec![(Value::from("id"), Value::from("w-1"))]),
        writer_user_id: None,
    };
    drive_projection_write(&registry, &upsert);
    assert_eq!(registry.snapshot("widget-counter", "tenant-1").len(), 1);

    // Delete must NOT reach projections (load-bearing quirk): snapshot unchanged.
    let delete = FrickStoreWriteEvent::ObjectDelete {
        tenant_id: "tenant-1".to_string(),
        app_id: DEFAULT_APP_ID.to_string(),
        object_type: "widget".to_string(),
        object_id: "w-1".to_string(),
    };
    drive_projection_write(&registry, &delete);
    assert_eq!(registry.snapshot("widget-counter", "tenant-1").len(), 1);
}

struct StreamHandler {
    seen: Arc<Mutex<Vec<Value>>>,
}
impl FrickProjectionHandler for StreamHandler {
    fn apply(
        &self,
        event: &FrickProjectionWriteEvent,
        _ctx: &FrickProjectionContext,
    ) -> ProjectionApplyResult {
        if let FrickProjectionWriteEvent::StreamEvent { stream_event, .. } = event {
            self.seen.lock().unwrap().push(stream_event.clone());
            ProjectionApplyResult::single("row", Some(stream_event.clone()))
        } else {
            ProjectionApplyResult::none()
        }
    }
}

#[test]
fn driver_routes_stream_append_to_stream_sources() {
    let registry = ProjectionRegistry::new();
    let seen: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));

    registry
        .register(FrickProjection::new(
            "feed",
            vec![FrickProjectionSource::stream("message")],
            Box::new(StreamHandler {
                seen: Arc::clone(&seen),
            }),
        ))
        .unwrap();

    let stored = StoredEvent {
        event: StreamEventInput {
            stream: "message".to_string(),
            stream_id: "conv-1".to_string(),
            sequence: 7,
            event_id: "evt-1".to_string(),
            event: "posted".to_string(),
            payload: Value::Map(vec![(Value::from("body"), Value::from("hi"))]),
        },
        tenant_id: "tenant-1".to_string(),
        app_id: DEFAULT_APP_ID.to_string(),
    };
    drive_projection_write(
        &registry,
        &FrickStoreWriteEvent::StreamAppend {
            tenant_id: "tenant-1".to_string(),
            event: stored,
        },
    );

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    // The stream_event value carries the renamed fields.
    let Value::Map(entries) = &seen[0] else {
        panic!("stream event should be a map")
    };
    let stream = entries
        .iter()
        .find(|(k, _)| k.as_str() == Some("stream"))
        .and_then(|(_, v)| v.as_str());
    assert_eq!(stream, Some("message"));
    assert_eq!(registry.snapshot("feed", "tenant-1").len(), 1);
}

#[test]
fn duplicate_register_errors_with_exact_message() {
    let registry = ProjectionRegistry::new();
    register_counter(&registry);
    let err = registry
        .register(FrickProjection::new(
            "widget-counter",
            vec![FrickProjectionSource::object("widget")],
            Box::new(CounterHandler::new()),
        ))
        .unwrap_err();
    assert_eq!(
        err.to_string(),
        "Projection \"widget-counter\" is already registered"
    );
}

#[test]
fn registration_order_is_preserved() {
    let registry = ProjectionRegistry::new();
    for name in ["c", "a", "b"] {
        registry
            .register(FrickProjection::new(
                name,
                vec![FrickProjectionSource::object("widget")],
                Box::new(CounterHandler::new()),
            ))
            .unwrap();
    }
    assert_eq!(registry.names(), vec!["c", "a", "b"]);
}

#[test]
fn rebuild_all_only_rebuilds_handlers_that_support_it() {
    let registry = ProjectionRegistry::new();

    let rebuildable = CounterHandler {
        rebuildable: true,
        ..CounterHandler::new()
    };
    let counter = Arc::clone(&rebuildable.rebuilds);
    registry
        .register(FrickProjection::new(
            "rebuildable",
            vec![FrickProjectionSource::object("widget")],
            Box::new(rebuildable),
        ))
        .unwrap();
    registry
        .register(FrickProjection::new(
            "plain",
            vec![FrickProjectionSource::object("widget")],
            Box::new(CounterHandler::new()),
        ))
        .unwrap();

    let result = registry.rebuild_all(&ctx());
    assert_eq!(result.rebuilt, vec!["rebuildable".to_string()]);
    assert_eq!(counter.load(Ordering::SeqCst), 1);
}

#[test]
fn rebuild_one_reports_not_found_and_not_supported() {
    let registry = ProjectionRegistry::new();
    register_counter(&registry);
    assert_eq!(
        registry.rebuild_one("missing", &ctx()),
        ProjectionRebuildOutcome::NotFound
    );
    assert_eq!(
        registry.rebuild_one("widget-counter", &ctx()),
        ProjectionRebuildOutcome::NotSupported
    );
}

#[test]
fn read_returns_405_when_no_read_impl_and_200_when_present() {
    let registry = ProjectionRegistry::new();
    register_counter(&registry);

    // No read impl → MethodNotAllowed.
    match read_projection(&registry, "widget-counter", &ctx(), &BTreeMap::new()) {
        ProjectionHttpRead::MethodNotAllowed => {}
        other => panic!("expected 405, got {other:?}"),
    }

    // Unknown → NotFound.
    match read_projection(&registry, "missing", &ctx(), &BTreeMap::new()) {
        ProjectionHttpRead::NotFound => {}
        other => panic!("expected 404, got {other:?}"),
    }

    // Now a readable projection → Found.
    let readable = CounterHandler {
        readable: true,
        ..CounterHandler::new()
    };
    registry
        .register(FrickProjection::new(
            "readable",
            vec![FrickProjectionSource::object("widget")],
            Box::new(readable),
        ))
        .unwrap();
    let mut query = BTreeMap::new();
    query.insert("key".to_string(), "w-1".to_string());
    match read_projection(&registry, "readable", &ctx(), &query) {
        ProjectionHttpRead::Found(data) => {
            let Value::Map(entries) = &data else {
                panic!("read data should be a map")
            };
            assert!(
                entries
                    .iter()
                    .any(|(k, v)| k.as_str() == Some("key") && v.as_str() == Some("w-1"))
            );
        }
        other => panic!("expected 200, got {other:?}"),
    }
}

struct ToggleHandler;
impl FrickProjectionHandler for ToggleHandler {
    fn apply(
        &self,
        event: &FrickProjectionWriteEvent,
        _ctx: &FrickProjectionContext,
    ) -> ProjectionApplyResult {
        let FrickProjectionWriteEvent::ObjectUpsert {
            object, object_id, ..
        } = event
        else {
            return ProjectionApplyResult::none();
        };
        // A `{ tombstone: true }` object deletes the row.
        let is_tombstone = object
            .as_map()
            .and_then(|m| m.iter().find(|(k, _)| k.as_str() == Some("tombstone")))
            .and_then(|(_, v)| v.as_bool())
            .unwrap_or(false);
        if is_tombstone {
            ProjectionApplyResult::single(object_id.clone(), None)
        } else {
            ProjectionApplyResult::single(object_id.clone(), Some(object.clone()))
        }
    }
}

#[test]
fn delete_change_prunes_row_from_snapshot() {
    let registry = ProjectionRegistry::new();

    registry
        .register(FrickProjection::new(
            "toggle",
            vec![FrickProjectionSource::object("widget")],
            Box::new(ToggleHandler),
        ))
        .unwrap();

    registry.notify(&object_upsert_event("w-1"), &ctx());
    assert_eq!(registry.snapshot("toggle", "tenant-1").len(), 1);

    // Tombstone deletes the row; the empty tenant/projection maps prune so the
    // snapshot is empty (and the projection drops out of `rows`).
    let tombstone = FrickProjectionWriteEvent::ObjectUpsert {
        tenant_id: "tenant-1".to_string(),
        app_id: DEFAULT_APP_ID.to_string(),
        object_type: "widget".to_string(),
        object_id: "w-1".to_string(),
        object: Value::Map(vec![(Value::from("tombstone"), Value::Boolean(true))]),
    };
    registry.notify(&tombstone, &ctx());
    assert!(registry.snapshot("toggle", "tenant-1").is_empty());
}

struct PanicHandler;
impl FrickProjectionHandler for PanicHandler {
    fn apply(
        &self,
        _event: &FrickProjectionWriteEvent,
        _ctx: &FrickProjectionContext,
    ) -> ProjectionApplyResult {
        panic!("boom");
    }
}

#[test]
fn handler_panic_is_caught_and_does_not_propagate() {
    let registry = ProjectionRegistry::new();

    registry
        .register(FrickProjection::new(
            "panicky",
            vec![FrickProjectionSource::object("widget")],
            Box::new(PanicHandler),
        ))
        .unwrap();
    register_counter(&registry);

    // Notify must not panic; the healthy projection still materializes.
    registry.notify(&object_upsert_event("w-1"), &ctx());
    assert_eq!(registry.snapshot("widget-counter", "tenant-1").len(), 1);
    assert!(registry.snapshot("panicky", "tenant-1").is_empty());
}

#[test]
fn notice_converts_to_frame_payload_with_nil_for_deletes() {
    let notice = ProjectionDeltaNotice {
        projection: "p".to_string(),
        tenant_id: "tenant-1".to_string(),
        app_id: DEFAULT_APP_ID.to_string(),
        changes: vec![
            ProjectionChange::upsert("a", Value::from(1_i64)),
            ProjectionChange::delete("b"),
        ],
    };
    let payload = notice_to_payload(&notice);
    assert_eq!(payload.projection, "p");
    assert_eq!(payload.changes.len(), 2);
    assert_eq!(payload.changes[0].key, "a");
    assert!(!payload.changes[0].is_delete());
    assert_eq!(payload.changes[1].key, "b");
    assert!(payload.changes[1].is_delete());
}

#[test]
fn list_body_reports_name_and_sources() {
    let registry = ProjectionRegistry::new();
    register_counter(&registry);
    let body = list_projections_body(&registry, "schema-hash-1");
    assert_eq!(body["schemaHash"], "schema-hash-1");
    let projections = body["projections"].as_array().unwrap();
    assert_eq!(projections.len(), 1);
    assert_eq!(projections[0]["name"], "widget-counter");
    assert_eq!(projections[0]["sources"][0]["kind"], "object");
    assert_eq!(projections[0]["sources"][0]["type"], "widget");
}
