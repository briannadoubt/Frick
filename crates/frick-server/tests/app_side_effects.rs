//! FR-304: app post-commit write side-effects registered via `BootSeams`. A
//! side-effect runs detached after a store write commits, with store access,
//! and an error never fails the originating write.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use frick_protocol::{FrickSchema, Value};
use frick_schema::SchemaBuilder;
use frick_schema::builder::field;
use frick_server::config::load_frick_config;
use frick_server::write_side_effects::{
    SharedWriteSideEffect, WriteSideEffect, WriteSideEffectFuture,
};
use frick_server::{BootSeams, FrickConfig, create_frick_server_with_seams};
use frick_store::{FrickStore, FrickStoreWriteEvent};

fn test_config() -> FrickConfig {
    let mut env = std::collections::BTreeMap::new();
    env.insert("FRICK_ENV".to_string(), "test".to_string());
    env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
    env.insert("FRICK_PORT".to_string(), "0".to_string());
    load_frick_config(&env).unwrap()
}

fn schema() -> FrickSchema {
    SchemaBuilder::new("se-test", "se-test")
        .hash("se-test-hash")
        .object("Note", 1, |o| o.field(field::string("body", 1).required()))
        .build()
        .expect("schema validates")
}

/// Records that it ran, the object type it saw, and that the store handle works.
struct Recording {
    ran: Arc<AtomicBool>,
    runs: Arc<AtomicUsize>,
    seen_type: Arc<Mutex<Option<String>>>,
}

impl WriteSideEffect for Recording {
    fn on_write(
        &self,
        event: FrickStoreWriteEvent,
        store: Arc<FrickStore>,
    ) -> WriteSideEffectFuture {
        let ran = Arc::clone(&self.ran);
        let runs = Arc::clone(&self.runs);
        let seen = Arc::clone(&self.seen_type);
        Box::pin(async move {
            if let FrickStoreWriteEvent::ObjectUpsert {
                tenant_id,
                app_id,
                object_type,
                object_id,
                ..
            } = &event
            {
                // Prove the store handle is usable from the side-effect.
                let _ = store
                    .objects()
                    .read(tenant_id, object_type, object_id, app_id)
                    .await;
                *seen.lock().unwrap() = Some(object_type.clone());
            }
            runs.fetch_add(1, Ordering::SeqCst);
            ran.store(true, Ordering::SeqCst);
            Ok(())
        })
    }
}

/// A side-effect that always errors — must not fail the originating write.
struct AlwaysErrs;
impl WriteSideEffect for AlwaysErrs {
    fn on_write(&self, _e: FrickStoreWriteEvent, _s: Arc<FrickStore>) -> WriteSideEffectFuture {
        Box::pin(async move { Err("boom".to_string()) })
    }
}

#[tokio::test]
async fn write_side_effect_runs_detached_with_store_access() {
    let ran = Arc::new(AtomicBool::new(false));
    let runs = Arc::new(AtomicUsize::new(0));
    let seen = Arc::new(Mutex::new(None));
    let mut seams = BootSeams::production();
    seams.write_side_effects = vec![
        Arc::new(Recording {
            ran: Arc::clone(&ran),
            runs: Arc::clone(&runs),
            seen_type: Arc::clone(&seen),
        }) as SharedWriteSideEffect,
        // A failing side-effect alongside it must not break the write or the
        // other side-effect.
        Arc::new(AlwaysErrs),
    ];
    let server = create_frick_server_with_seams(test_config(), schema(), seams)
        .await
        .unwrap();

    // A store write fires the funnel → handle_store_write → side-effects (spawned).
    let result = server
        .state
        .store
        .upsert_object_with_policy(
            "_default",
            "_default",
            "Note",
            "n-1",
            &Value::Map(vec![("body".into(), "hi".into())]),
            None,
            None,
        )
        .await;
    assert!(
        result.is_ok(),
        "the write succeeds despite a failing side-effect"
    );

    // Await the detached side-effect.
    for _ in 0..200 {
        if ran.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(ran.load(Ordering::SeqCst), "the write side-effect ran");
    assert_eq!(
        runs.load(Ordering::SeqCst),
        1,
        "ran exactly once for the write"
    );
    assert_eq!(seen.lock().unwrap().as_deref(), Some("Note"));
}
