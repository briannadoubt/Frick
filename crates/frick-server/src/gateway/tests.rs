//! Gateway tests: handshake-gate + dispatch decisions on synthesized frames,
//! plus a real WebSocket round-trip (dev-login → Hello → HelloAck+Schema →
//! Subscribe object → ObjectUpsert → Delta).

use std::collections::BTreeMap;
use std::time::Duration;

use frick_protocol::frame::{
    HelloPayload, ObjectUpsertPayload, SubscribePayload, SubscriptionKind,
};
use frick_protocol::schema::{FieldDef, FieldKind, ObjectDef};
use frick_protocol::{FrickFrame, FrickSchema, Value, decode_frame, encode_frame};
use tokio_tungstenite::tungstenite::Message as TungMessage;

use super::*;
use crate::boot::create_frick_server;
use crate::config::{FrickConfig, load_frick_config};
use crate::http::AppStateInner;
use crate::principal::DEFAULT_TENANT_ID;

// ---- pure unit tests (no socket) --------------------------------------------

#[test]
fn pre_hello_request_id_extracts_per_kind() {
    let subscribe = FrickFrame::Subscribe(SubscribePayload {
        subscription_id: "sub-1".into(),
        kind: SubscriptionKind::Object,
        name: "Note".into(),
        key: None,
        cursor: None,
    });
    assert_eq!(super::pre_hello_request_id(&subscribe), "sub-1");

    let upsert = FrickFrame::ObjectUpsert(ObjectUpsertPayload {
        request_id: "req-9".into(),
        object_type: "Note".into(),
        object_id: "n1".into(),
        value: Value::Map(vec![]),
        expected_version: None,
    });
    assert_eq!(super::pre_hello_request_id(&upsert), "req-9");

    // A frame kind with no natural request id falls back to "pre-hello".
    let ping = FrickFrame::Ping(frick_protocol::frame::PingPayload { sent_at: 0 });
    assert_eq!(super::pre_hello_request_id(&ping), "pre-hello");
}

#[test]
fn subscribe_action_maps_each_kind() {
    assert_eq!(
        super::subscribe_action(SubscriptionKind::Object),
        Action::ObjectRead
    );
    assert_eq!(
        super::subscribe_action(SubscriptionKind::Stream),
        Action::StreamRead
    );
    assert_eq!(
        super::subscribe_action(SubscriptionKind::Presence),
        Action::PresenceRead
    );
    assert_eq!(
        super::subscribe_action(SubscriptionKind::Signal),
        Action::SignalRead
    );
}

#[test]
fn auth_nack_uses_unauthenticated_code_for_unauthenticated_reason() {
    // Build the hub over a state whose schema is the foundation so we can
    // synthesize an enqueued frame and read it back off the outbound channel.
    let nack = super::simple_nack(
        FrickErrorCode::AuthForbidden,
        "nope",
        "req-1",
        false,
        Some(Value::Map(vec![("reason".into(), "ownerMismatch".into())])),
        None,
    );
    let FrickFrame::Nack(payload) = nack else {
        panic!("expected nack");
    };
    // Code/message are duplicated at the payload top level.
    assert_eq!(payload.code, Some(FrickErrorCode::AuthForbidden));
    assert_eq!(payload.message.as_deref(), Some("nope"));
    assert_eq!(payload.error.code, FrickErrorCode::AuthForbidden);
    assert_eq!(payload.request_id, "req-1");
}

#[test]
fn handshake_gate_rejects_non_hello_frames_before_hello() {
    // Drive a synthesized connection through the dispatch gate by registering a
    // connection and calling `handle_raw_frame` with a Subscribe before Hello.
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let hub = test_hub().await;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<super::Outbound>();
        let id = hub.register(super::Connection {
            principal: None,
            session_token: None,
            app_id: DEFAULT_APP_ID.to_string(),
            handshake_complete: false,
            subscriptions: std::collections::HashSet::new(),
            pending_writes: 0,
            outbound: tx,
        });

        let frame = FrickFrame::Subscribe(SubscribePayload {
            subscription_id: "sub-x".into(),
            kind: SubscriptionKind::Object,
            name: "Note".into(),
            key: None,
            cursor: None,
        });
        let bytes = encode_frame(&frame).unwrap();
        let close = super::handle_raw_frame(&hub, id, &bytes).await;
        assert!(!close, "a gated subscribe should not close the connection");

        let out = rx.try_recv().expect("a nack frame");
        let super::Outbound::Frame(bytes) = out else {
            panic!("expected a frame");
        };
        let FrickFrame::Nack(nack) = decode_frame(&bytes).unwrap() else {
            panic!("expected nack");
        };
        assert_eq!(nack.error.code, FrickErrorCode::SyncProtocolError);
        assert_eq!(nack.request_id, "sub-x");
        // reason handshakeRequired in details.
        let Some(Value::Map(details)) = &nack.error.details else {
            panic!("details map");
        };
        assert!(
            details
                .iter()
                .any(|(k, v)| k.as_str() == Some("reason")
                    && v.as_str() == Some("handshakeRequired"))
        );
    });
}

#[test]
fn ping_is_allowed_pre_hello_and_pongs() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let hub = test_hub().await;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<super::Outbound>();
        let id = hub.register(super::Connection {
            principal: None,
            session_token: None,
            app_id: DEFAULT_APP_ID.to_string(),
            handshake_complete: false,
            subscriptions: std::collections::HashSet::new(),
            pending_writes: 0,
            outbound: tx,
        });
        let bytes = encode_frame(&FrickFrame::Ping(frick_protocol::frame::PingPayload {
            sent_at: 7,
        }))
        .unwrap();
        super::handle_raw_frame(&hub, id, &bytes).await;
        let super::Outbound::Frame(bytes) = rx.try_recv().expect("a pong") else {
            panic!("expected a frame");
        };
        let FrickFrame::Pong(pong) = decode_frame(&bytes).unwrap() else {
            panic!("expected pong");
        };
        assert_eq!(pong.sent_at, 7);
    });
}

#[test]
fn store_write_listener_fans_out_object_upsert_to_subscriber() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let hub = test_hub().await;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<super::Outbound>();
        let principal = Principal {
            user_id: "user-ada".into(),
            device_id: "d".into(),
            replica_id: "r".into(),
            tenant_id: DEFAULT_TENANT_ID.to_string(),
            scope: crate::principal::PrincipalScope::Tenant,
            service_scopes: vec![],
        };
        let id = hub.register(super::Connection {
            principal: Some(principal),
            session_token: None,
            app_id: DEFAULT_APP_ID.to_string(),
            handshake_complete: true,
            subscriptions: [super::SubKey {
                subscription_id: "sub-notes".into(),
                kind: SubscriptionKind::Object,
                name: "Note".into(),
                key: None,
            }]
            .into_iter()
            .collect(),
            pending_writes: 0,
            outbound: tx,
        });
        let _ = id;

        // Fire the funnel directly (the integrator wires this to the store).
        hub.handle_store_write(&FrickStoreWriteEvent::ObjectUpsert {
            tenant_id: DEFAULT_TENANT_ID.to_string(),
            app_id: DEFAULT_APP_ID.to_string(),
            object_type: "Note".into(),
            object_id: "n1".into(),
            object: note_value("n1", "hi"),
            writer_user_id: None,
        });

        let super::Outbound::Frame(bytes) = rx.try_recv().expect("a delta") else {
            panic!("expected a frame");
        };
        let FrickFrame::Delta(delta) = decode_frame(&bytes).unwrap() else {
            panic!("expected delta");
        };
        assert_eq!(delta.objects.len(), 1);
        assert_eq!(delta.objects[0].1, "n1");
    });
}

#[test]
fn store_write_listener_skips_other_tenant() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let hub = test_hub().await;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<super::Outbound>();
        let principal = Principal {
            user_id: "user-ada".into(),
            device_id: "d".into(),
            replica_id: "r".into(),
            tenant_id: DEFAULT_TENANT_ID.to_string(),
            scope: crate::principal::PrincipalScope::Tenant,
            service_scopes: vec![],
        };
        hub.register(super::Connection {
            principal: Some(principal),
            session_token: None,
            app_id: DEFAULT_APP_ID.to_string(),
            handshake_complete: true,
            subscriptions: [super::SubKey {
                subscription_id: "sub-notes".into(),
                kind: SubscriptionKind::Object,
                name: "Note".into(),
                key: None,
            }]
            .into_iter()
            .collect(),
            pending_writes: 0,
            outbound: tx,
        });

        // A write under a DIFFERENT tenant must not reach this subscriber.
        hub.handle_store_write(&FrickStoreWriteEvent::ObjectUpsert {
            tenant_id: "tenant-other".into(),
            app_id: DEFAULT_APP_ID.to_string(),
            object_type: "Note".into(),
            object_id: "n1".into(),
            object: note_value("n1", "hi"),
            writer_user_id: None,
        });
        assert!(
            rx.try_recv().is_err(),
            "cross-tenant write should not fan out"
        );
    });
}

// ---- close_session (FR-278) -------------------------------------------------

/// Register a connection with the given principal + token, returning its id and
/// the receiver end of its outbound channel.
fn register_test_connection(
    hub: &std::sync::Arc<GatewayHub>,
    principal: Option<Principal>,
    session_token: Option<&str>,
) -> (u64, tokio::sync::mpsc::UnboundedReceiver<super::Outbound>) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<super::Outbound>();
    let id = hub.register(super::Connection {
        principal,
        session_token: session_token.map(str::to_string),
        app_id: DEFAULT_APP_ID.to_string(),
        handshake_complete: true,
        subscriptions: std::collections::HashSet::new(),
        pending_writes: 0,
        outbound: tx,
    });
    (id, rx)
}

fn tenant_principal(user_id: &str, tenant_id: &str) -> Principal {
    Principal {
        user_id: user_id.into(),
        device_id: "d".into(),
        replica_id: "r".into(),
        tenant_id: tenant_id.into(),
        scope: crate::principal::PrincipalScope::Tenant,
        service_scopes: vec![],
    }
}

/// FR-308: the write-rate token bucket allows up to `burst` immediately, denies
/// once drained, and refills over time.
#[test]
fn write_rate_token_bucket_bursts_denies_and_refills() {
    use super::TokenBucket;
    use std::time::{Duration, Instant};

    let burst = 3.0;
    let refill = 2.0; // tokens per second
    let t0 = Instant::now();
    let mut bucket = TokenBucket::new(burst, t0);

    // Full bucket: three immediate writes succeed, the fourth is denied.
    assert!(bucket.try_consume(t0, burst, refill));
    assert!(bucket.try_consume(t0, burst, refill));
    assert!(bucket.try_consume(t0, burst, refill));
    assert!(
        !bucket.try_consume(t0, burst, refill),
        "bucket is drained after the burst"
    );

    // After 500ms, refill = 2/s * 0.5 = 1 token → exactly one more write.
    let t1 = t0 + Duration::from_millis(500);
    assert!(bucket.try_consume(t1, burst, refill));
    assert!(
        !bucket.try_consume(t1, burst, refill),
        "only one token refilled"
    );

    // Refill is capped at `burst` even after a long idle period.
    let t2 = t1 + Duration::from_secs(100);
    assert!(bucket.try_consume(t2, burst, refill));
    assert!(bucket.try_consume(t2, burst, refill));
    assert!(bucket.try_consume(t2, burst, refill));
    assert!(
        !bucket.try_consume(t2, burst, refill),
        "refill never exceeds burst capacity"
    );
}

/// FR-308: with the bucket disabled (burst <= 0, the default), the gate always
/// allows — proving the wiring is backward compatible.
#[test]
fn write_rate_gate_is_disabled_by_default() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let hub = test_hub().await;
        assert_eq!(hub.limits().write_rate_burst, 0, "disabled by default");
        // Many consecutive consumes all allowed when disabled.
        for _ in 0..1000 {
            assert!(super::try_consume_write_token(&hub, "tenant\0user"));
        }
    });
}

/// FR-307: connection-lifecycle hooks fire on register/unregister with the new
/// live count, so an active-connection gauge can wire into the seam.
#[test]
fn connection_lifecycle_hooks_fire_on_connect_and_disconnect() {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Default)]
    struct Recorder {
        connects: Mutex<Vec<usize>>,
        disconnects: Mutex<Vec<usize>>,
        live: AtomicUsize,
    }
    impl super::ConnectionLifecycleHook for Recorder {
        fn on_connect(&self, active: usize) {
            self.connects.lock().unwrap().push(active);
            self.live.store(active, Ordering::SeqCst);
        }
        fn on_disconnect(&self, active: usize) {
            self.disconnects.lock().unwrap().push(active);
            self.live.store(active, Ordering::SeqCst);
        }
    }

    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let recorder = std::sync::Arc::new(Recorder::default());
        let hooks: super::ConnectionLifecycleHooks = std::sync::Arc::new(vec![
            recorder.clone() as std::sync::Arc<dyn super::ConnectionLifecycleHook>
        ]);
        let hub = test_hub_with_lifecycle(note_schema(), hooks).await;

        let (id_a, _rx_a) = register_test_connection(
            &hub,
            Some(tenant_principal("user-a", DEFAULT_TENANT_ID)),
            None,
        );
        let (id_b, _rx_b) = register_test_connection(
            &hub,
            Some(tenant_principal("user-b", DEFAULT_TENANT_ID)),
            None,
        );
        assert_eq!(
            *recorder.connects.lock().unwrap(),
            vec![1, 2],
            "on_connect sees the running live count"
        );

        hub.unregister(id_a);
        hub.unregister(id_b);
        assert_eq!(
            *recorder.disconnects.lock().unwrap(),
            vec![1, 0],
            "on_disconnect sees the decremented live count"
        );
        assert_eq!(recorder.live.load(Ordering::SeqCst), 0);
        assert_eq!(hub.connection_count(), 0);
    });
}

#[test]
fn federation_hooks_fire_on_local_write() {
    use std::sync::Mutex;

    #[derive(Default)]
    struct Recorder {
        seen: Mutex<Vec<String>>,
    }
    impl crate::federation::FederationHook for Recorder {
        fn on_local_write(&self, event: &FrickStoreWriteEvent) {
            if let FrickStoreWriteEvent::ObjectUpsert { object_id, .. } = event {
                self.seen.lock().unwrap().push(object_id.clone());
            }
        }
    }

    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let recorder = std::sync::Arc::new(Recorder::default());
        let hooks: crate::federation::FederationHooks = std::sync::Arc::new(vec![
            recorder.clone() as std::sync::Arc<dyn crate::federation::FederationHook>
        ]);
        let hub = test_hub_with_seams(note_schema(), std::sync::Arc::new(Vec::new()), hooks).await;

        hub.handle_store_write(&FrickStoreWriteEvent::ObjectUpsert {
            tenant_id: DEFAULT_TENANT_ID.to_string(),
            app_id: DEFAULT_APP_ID.to_string(),
            object_type: "Note".into(),
            object_id: "fed-1".into(),
            object: note_value("fed-1", "hi"),
            writer_user_id: None,
        });

        // The federation hook observed the locally-originated write.
        assert_eq!(*recorder.seen.lock().unwrap(), vec!["fed-1".to_owned()]);
    });
}

#[test]
fn close_session_by_token_closes_only_the_matching_connection() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let hub = test_hub().await;
        let (_id_a, mut rx_a) = register_test_connection(
            &hub,
            Some(tenant_principal("user-ada", DEFAULT_TENANT_ID)),
            Some("tok-ada"),
        );
        let (_id_b, mut rx_b) = register_test_connection(
            &hub,
            Some(tenant_principal("user-bo", DEFAULT_TENANT_ID)),
            Some("tok-bo"),
        );

        let closed = hub.close_session(&super::CloseTarget::Token("tok-ada".into()));
        assert_eq!(closed, 1, "exactly one connection holds tok-ada");

        // Ada's connection got a policy-violation close; Bo's got nothing.
        match rx_a.try_recv() {
            Ok(super::Outbound::Close(code, reason)) => {
                assert_eq!(code, super::close::POLICY_VIOLATION);
                assert_eq!(reason, "Session revoked");
            }
            other => panic!("expected a close for ada, got {other:?}"),
        }
        assert!(rx_b.try_recv().is_err(), "bo must not be closed");
    });
}

#[test]
fn close_session_by_user_is_tenant_scoped() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let hub = test_hub().await;
        // Same user id in two tenants + a different user in the target tenant.
        let (_id1, mut rx1) = register_test_connection(
            &hub,
            Some(tenant_principal("user-x", "tenant-1")),
            Some("t1"),
        );
        let (_id2, mut rx2) = register_test_connection(
            &hub,
            Some(tenant_principal("user-x", "tenant-2")),
            Some("t2"),
        );
        let (_id3, mut rx3) = register_test_connection(
            &hub,
            Some(tenant_principal("user-y", "tenant-1")),
            Some("t3"),
        );

        // Scoped to tenant-1 → only user-x@tenant-1 closes.
        let closed = hub.close_session(&super::CloseTarget::User {
            user_id: "user-x".into(),
            tenant_id: Some("tenant-1".into()),
        });
        assert_eq!(closed, 1, "only user-x in tenant-1 matches");
        assert!(matches!(rx1.try_recv(), Ok(super::Outbound::Close(_, _))));
        assert!(rx2.try_recv().is_err(), "user-x@tenant-2 is out of scope");
        assert!(rx3.try_recv().is_err(), "user-y is a different user");
    });
}

#[test]
fn close_session_by_user_unscoped_spans_tenants() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let hub = test_hub().await;
        // Hold both receivers alive — a dropped receiver closes the channel, so
        // the outbound `send` would fail and the connection wouldn't be counted.
        let (_id1, _rx1) = register_test_connection(
            &hub,
            Some(tenant_principal("user-x", "tenant-1")),
            Some("t1"),
        );
        let (_id2, _rx2) = register_test_connection(
            &hub,
            Some(tenant_principal("user-x", "tenant-2")),
            Some("t2"),
        );
        let closed = hub.close_session(&super::CloseTarget::User {
            user_id: "user-x".into(),
            tenant_id: None,
        });
        assert_eq!(closed, 2, "an unscoped revoke spans every tenant");
    });
}

#[test]
fn close_session_ignores_anonymous_connections() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let hub = test_hub().await;
        // Anonymous: no principal, no token — matches nothing.
        let (_id, mut rx) = register_test_connection(&hub, None, None);
        assert_eq!(
            hub.close_session(&super::CloseTarget::Token("whatever".into())),
            0
        );
        assert_eq!(
            hub.close_session(&super::CloseTarget::User {
                user_id: "user-x".into(),
                tenant_id: None,
            }),
            0
        );
        assert!(
            rx.try_recv().is_err(),
            "an anonymous connection is untouched"
        );
    });
}

/// The state's `gateway()` accessor upgrades the wired hub, and `close_session`
/// reached through it closes the right connection — the path the HTTP control
/// plane uses (logout / admin revoke).
#[test]
fn state_gateway_accessor_reaches_close_session() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let hub = test_hub().await;
        let (_id, mut rx) = register_test_connection(
            &hub,
            Some(tenant_principal("user-ada", DEFAULT_TENANT_ID)),
            Some("tok-ada"),
        );
        // `test_hub` already attached the hub to its state.
        let reached = hub.state.gateway().expect("gateway is attached");
        assert_eq!(
            reached.close_session(&super::CloseTarget::Token("tok-ada".into())),
            1
        );
        assert!(matches!(rx.try_recv(), Ok(super::Outbound::Close(_, _))));
    });
}

#[test]
fn cluster_bus_fans_a_write_on_hub_a_to_a_subscriber_on_hub_b() {
    // Two hubs sharing one MemoryClusterChannel: an object upsert that reaches
    // hub A's store-write funnel publishes an `objects` envelope on the shared
    // channel; hub B's inbound subscriber runs the SAME local fan-out, so a
    // subscriber connected to hub B receives the Delta — without hub A having
    // any local subscriber for it (cross-node fan-out, map 06 §1.4).
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        use crate::cluster::{MemoryClusterBus, MemoryClusterBusOptions, MemoryClusterChannel};

        let channel = MemoryClusterChannel::new();
        let hub_a = test_hub().await;
        let hub_b = test_hub().await;
        hub_a.set_cluster_bus(MemoryClusterBus::with_options(MemoryClusterBusOptions {
            node_id: Some("node-a".into()),
            channel: Some(channel.clone()),
        }));
        hub_b.set_cluster_bus(MemoryClusterBus::with_options(MemoryClusterBusOptions {
            node_id: Some("node-b".into()),
            channel: Some(channel),
        }));

        // A subscriber lives on hub B only.
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<super::Outbound>();
        let principal = Principal {
            user_id: "user-ada".into(),
            device_id: "d".into(),
            replica_id: "r".into(),
            tenant_id: DEFAULT_TENANT_ID.to_string(),
            scope: crate::principal::PrincipalScope::Tenant,
            service_scopes: vec![],
        };
        hub_b.register(super::Connection {
            principal: Some(principal),
            session_token: None,
            app_id: DEFAULT_APP_ID.to_string(),
            handshake_complete: true,
            subscriptions: [super::SubKey {
                subscription_id: "sub-notes".into(),
                kind: SubscriptionKind::Object,
                name: "Note".into(),
                key: None,
            }]
            .into_iter()
            .collect(),
            pending_writes: 0,
            outbound: tx,
        });

        // A write lands on hub A (no local subscriber there).
        hub_a.handle_store_write(&FrickStoreWriteEvent::ObjectUpsert {
            tenant_id: DEFAULT_TENANT_ID.to_string(),
            app_id: DEFAULT_APP_ID.to_string(),
            object_type: "Note".into(),
            object_id: "n1".into(),
            object: note_value("n1", "cross-node"),
            writer_user_id: None,
        });

        // The Delta arrives at hub B's subscriber over the cluster bus.
        let super::Outbound::Frame(bytes) = rx.try_recv().expect("a delta on hub B") else {
            panic!("expected a frame");
        };
        let FrickFrame::Delta(delta) = decode_frame(&bytes).unwrap() else {
            panic!("expected delta");
        };
        assert_eq!(delta.objects.len(), 1);
        assert_eq!(delta.objects[0].1, "n1");
    });
}

#[test]
fn cluster_bus_loop_guard_skips_origin_node_own_subscribers() {
    // The hub that originates a write must NOT receive its own envelope back
    // (the bus loop guard). Hub A has a local subscriber AND publishes; the
    // subscriber should see the local fan-out exactly once (from the store
    // write), never a duplicate from the inbound handler.
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        use crate::cluster::{MemoryClusterBus, MemoryClusterBusOptions, MemoryClusterChannel};

        let channel = MemoryClusterChannel::new();
        let hub_a = test_hub().await;
        hub_a.set_cluster_bus(MemoryClusterBus::with_options(MemoryClusterBusOptions {
            node_id: Some("node-a".into()),
            channel: Some(channel),
        }));

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<super::Outbound>();
        hub_a.register(super::Connection {
            principal: Some(Principal {
                user_id: "u".into(),
                device_id: "d".into(),
                replica_id: "r".into(),
                tenant_id: DEFAULT_TENANT_ID.to_string(),
                scope: crate::principal::PrincipalScope::Tenant,
                service_scopes: vec![],
            }),
            session_token: None,
            app_id: DEFAULT_APP_ID.to_string(),
            handshake_complete: true,
            subscriptions: [super::SubKey {
                subscription_id: "sub-notes".into(),
                kind: SubscriptionKind::Object,
                name: "Note".into(),
                key: None,
            }]
            .into_iter()
            .collect(),
            pending_writes: 0,
            outbound: tx,
        });

        hub_a.handle_store_write(&FrickStoreWriteEvent::ObjectUpsert {
            tenant_id: DEFAULT_TENANT_ID.to_string(),
            app_id: DEFAULT_APP_ID.to_string(),
            object_type: "Note".into(),
            object_id: "n1".into(),
            object: note_value("n1", "local"),
            writer_user_id: None,
        });

        // Exactly one Delta (the local fan-out); no echo from the bus.
        assert!(
            matches!(rx.try_recv(), Ok(super::Outbound::Frame(_))),
            "the local delta"
        );
        assert!(
            rx.try_recv().is_err(),
            "no duplicate from the loop-guarded inbound path"
        );
    });
}

// ---- WebSocket round-trip ---------------------------------------------------

/// Boot a server, open a real ws client, dev-login, Hello → HelloAck+Schema,
/// subscribe to an object type, upsert, and assert the Delta arrives.
#[tokio::test]
async fn ws_round_trip_hello_subscribe_upsert_delta() {
    use futures_util::SinkExt;

    let schema = note_schema();
    let mut server = create_frick_server(test_config(), schema.clone())
        .await
        .unwrap();

    // Build the hub over the SAME app state the server serves, merge its router
    // onto a fresh listener, and register the write listener — this mirrors the
    // integrator wiring exactly (see the module docs / integratorApi).
    let hub = GatewayHub::new(std::sync::Arc::clone(&server.state));
    server.state.store.set_write_listener(hub.write_listener());

    // Serve the gateway router on its own port (the boot router doesn't merge
    // the gateway in this story; the integrator does).
    let app = hub.router();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let serve = tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });

    // dev-login for a token via the HTTP auth surface (boot router).
    let http_port = server.listen().await.unwrap();
    let token = dev_login_token(http_port, "user-ada").await;

    // Open the ws client.
    let url = format!("ws://127.0.0.1:{port}/_frick/sync");
    let (mut socket, _response) = tokio_tungstenite::connect_async(&url).await.unwrap();

    // Hello (authenticated).
    let hello = FrickFrame::Hello(Box::new(HelloPayload {
        replica_id: "replica-1".into(),
        device_id: "device-1".into(),
        schema_hash: schema.hash.clone(),
        // Empty cursor map; collected from no entries to avoid a direct
        // `indexmap` dependency in this crate's test surface.
        known_cursors: std::iter::empty::<(String, i64)>().collect(),
        session_token: Some(token),
        client_capabilities: None,
    }));
    socket
        .send(TungMessage::Binary(encode_frame(&hello).unwrap()))
        .await
        .unwrap();

    // Expect HelloAck then Schema.
    let ack = next_frame(&mut socket).await;
    assert!(matches!(ack, FrickFrame::HelloAck(_)), "got {ack:?}");
    let schema_frame = next_frame(&mut socket).await;
    assert!(
        matches!(schema_frame, FrickFrame::Schema(_)),
        "got {schema_frame:?}"
    );

    // Subscribe to the Note object type.
    let subscribe = FrickFrame::Subscribe(SubscribePayload {
        subscription_id: "sub-notes".into(),
        kind: SubscriptionKind::Object,
        name: "Note".into(),
        key: None,
        cursor: None,
    });
    socket
        .send(TungMessage::Binary(encode_frame(&subscribe).unwrap()))
        .await
        .unwrap();
    let snapshot = next_frame(&mut socket).await;
    let FrickFrame::Snapshot(snapshot) = snapshot else {
        panic!("expected snapshot, got {snapshot:?}");
    };
    assert_eq!(snapshot.subscription_id, "sub-notes");
    assert!(snapshot.objects.is_empty(), "fresh store has no notes yet");

    // ObjectUpsert a note.
    let upsert = FrickFrame::ObjectUpsert(ObjectUpsertPayload {
        request_id: "req-1".into(),
        object_type: "Note".into(),
        object_id: "n1".into(),
        value: note_value("n1", "hello"),
        expected_version: None,
    });
    socket
        .send(TungMessage::Binary(encode_frame(&upsert).unwrap()))
        .await
        .unwrap();

    // The Ack and the Delta both arrive (order: the funnel fires after the
    // store write returns, so the Ack may come first). Collect frames until we
    // see a Delta carrying our note.
    let mut saw_ack = false;
    let mut saw_delta = false;
    for _ in 0..4 {
        match next_frame(&mut socket).await {
            FrickFrame::Ack(ack) => {
                assert_eq!(ack.request_id, "req-1");
                assert_eq!(ack.version, Some(1));
                saw_ack = true;
            }
            FrickFrame::Delta(delta) => {
                assert_eq!(delta.objects.len(), 1);
                assert_eq!(delta.objects[0].1, "n1");
                saw_delta = true;
            }
            other => panic!("unexpected frame {other:?}"),
        }
        if saw_ack && saw_delta {
            break;
        }
    }
    assert!(saw_ack && saw_delta, "expected both an Ack and a Delta");

    socket.close(None).await.ok();
    serve.abort();
    server.close().await;
}

/// Handshake gate over a real socket: a Subscribe before Hello is Nacked with
/// `handshakeRequired` and the connection stays open.
#[tokio::test]
async fn ws_handshake_gate_over_socket() {
    use futures_util::SinkExt;

    let schema = note_schema();
    let server = create_frick_server(test_config(), schema.clone())
        .await
        .unwrap();
    let hub = GatewayHub::new(std::sync::Arc::clone(&server.state));
    let app = hub.router();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let serve = tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });

    let url = format!("ws://127.0.0.1:{port}/_frick/sync");
    let (mut socket, _) = tokio_tungstenite::connect_async(&url).await.unwrap();

    let subscribe = FrickFrame::Subscribe(SubscribePayload {
        subscription_id: "sub-early".into(),
        kind: SubscriptionKind::Object,
        name: "Note".into(),
        key: None,
        cursor: None,
    });
    socket
        .send(TungMessage::Binary(encode_frame(&subscribe).unwrap()))
        .await
        .unwrap();

    let FrickFrame::Nack(nack) = next_frame(&mut socket).await else {
        panic!("expected a nack");
    };
    assert_eq!(nack.error.code, FrickErrorCode::SyncProtocolError);
    assert_eq!(nack.request_id, "sub-early");

    socket.close(None).await.ok();
    serve.abort();
}

/// FR-256 regression: a client that subscribes to an object type and then —
/// while the Subscribe is still completing — writes a matching object must still
/// receive that write's echo Delta.
///
/// Before the fix, `handle_subscribe` registered the subscription only AFTER it
/// awaited `active_principal_for_frame` (per-frame session re-validation). A
/// write whose store-write fan-out fired in that window saw `subscribers:0` for
/// the connection and dropped the live Delta. The fix registers the
/// subscription synchronously, before that await, so a racing fan-out finds the
/// subscriber.
///
/// The bug only manifests while `handle_subscribe` is suspended between its
/// start and the registration point. The in-memory store never actually
/// suspends, so the test installs a deterministic suspension seam
/// ([`super::install_subscribe_pause`]) that parks `handle_subscribe` at exactly
/// the spot it awaits its async session re-validation in production. With the
/// fix the subscription is already registered when the handler parks; against
/// the old ordering it is not. While parked we fire the matching write — the
/// client's immediate write racing the in-flight Subscribe — then release the
/// handler. The written object is NOT persisted, so the post-authz Snapshot
/// cannot backstop a dropped Delta: the live Delta is the only delivery path.
/// Against the old ordering the parked handler has not registered yet, so the
/// write sees `subscribers:0` and the Delta is dropped — this test fails.
///
/// This exercises `SubscriptionKind::Object`, but the fix is **kind-agnostic**:
/// `handle_subscribe` calls `add_subscription` (gateway.rs) with the payload's
/// `kind` unconditionally, synchronously, before the session-revalidation await
/// — the same ordering for object/stream/projection/presence/signal alike. The
/// Object scenario is therefore representative of the registration ordering for
/// every kind; the per-kind fan-out paths (stream `StreamPage`, projection
/// `ProjectionDelta`) are covered by their own gateway/conformance tests.
#[tokio::test]
async fn fr256_subscribe_then_immediate_write_delivers_echo_delta() {
    use frick_protocol::frame::SubscribePayload;
    use frick_store::stores::session::CreateSessionInput;

    let hub = test_hub().await;

    // A real, active session so the per-frame re-validation
    // (`active_principal_for_frame`) authenticates the principal.
    let token = "tok-fr256";
    hub.state
        .store
        .sessions()
        .create(
            &CreateSessionInput {
                session_token: token.into(),
                tenant_id: DEFAULT_TENANT_ID.into(),
                user_id: "user-ada".into(),
                device_id: "device-1".into(),
                replica_id: "replica-1".into(),
                expires_at: "2999-01-01T00:00:00.000Z".into(),
            },
            now_ms(),
        )
        .await
        .expect("session created");
    let principal = principal_from_active_session_token(&hub.state.store, token, now_ms())
        .await
        .expect("active principal");

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<super::Outbound>();
    let id = hub.register(super::Connection {
        principal: Some(principal),
        session_token: Some(token.to_string()),
        app_id: DEFAULT_APP_ID.to_string(),
        handshake_complete: true,
        subscriptions: std::collections::HashSet::new(),
        pending_writes: 0,
        outbound: tx,
    });

    // Install the suspension seam for this connection BEFORE driving the
    // Subscribe; the handler parks at it (after the fix's synchronous
    // registration, before the session-revalidation await).
    let (arrived, release) = super::install_subscribe_pause(id);

    let hub_sub = std::sync::Arc::clone(&hub);
    let subscribe = tokio::spawn(async move {
        super::handle_subscribe(
            &hub_sub,
            id,
            SubscribePayload {
                subscription_id: "sub-notes".into(),
                kind: SubscriptionKind::Object,
                name: "Note".into(),
                key: None,
                cursor: None,
            },
        )
        .await
    });

    // Wait until the handler reaches the suspension point.
    arrived.notified().await;

    // Sanity-check the fix's ordering guarantee directly: at the suspension
    // point (production's session-revalidation await) the subscription must
    // already be registered, so a concurrent fan-out finds it.
    let registered = hub.inner.lock().is_ok_and(|inner| {
        inner.connections.get(&id).is_some_and(|connection| {
            connection
                .subscriptions
                .iter()
                .any(|sub| sub.subscription_id == "sub-notes")
        })
    });
    assert!(
        registered,
        "FR-256: the subscription must be registered before handle_subscribe awaits its \
         session re-validation; a concurrent write here must not see subscribers:0"
    );

    // Fire the matching write while the Subscribe is parked. `n1` is NOT stored,
    // so only the live Delta can deliver it; a Snapshot cannot mask a drop.
    hub.handle_store_write(&FrickStoreWriteEvent::ObjectUpsert {
        tenant_id: DEFAULT_TENANT_ID.to_string(),
        app_id: DEFAULT_APP_ID.to_string(),
        object_type: "Note".into(),
        object_id: "n1".into(),
        object: note_value("n1", "raced"),
        writer_user_id: None,
    });

    // Release the handler and let it finish (authz passes, snapshot emitted).
    release.notify_one();
    subscribe.await.expect("subscribe task");

    // The connection must have received the Delta for n1 (a Snapshot may also
    // arrive, but it is empty — n1 was never stored).
    let mut saw_delta = false;
    while let Ok(out) = rx.try_recv() {
        let super::Outbound::Frame(bytes) = out else {
            continue;
        };
        if let FrickFrame::Delta(delta) = decode_frame(&bytes).unwrap()
            && delta.objects.iter().any(|object| object.1 == "n1")
        {
            saw_delta = true;
        }
    }

    assert!(
        saw_delta,
        "the subscriber must receive its own immediate write's echo Delta; got none — \
         the subscribe-then-write race dropped it (fan-out saw subscribers:0)"
    );
}

/// FR-285 — creating a call enqueues one `call.ringing` push intent per invitee.
///
/// Drives [`enqueue_ringing_push`] directly (the `Op::Create` arm of
/// [`handle_call_command`] calls it after the control plane returns the room +
/// invites). Asserts the durable `push.deliver` jobs landed in the store, one
/// per invitee, each decoding to a `call.ringing` intent that targets that
/// invitee and carries `{ type, callId, conversationId, createdBy }` in `data`.
#[tokio::test]
async fn create_call_enqueues_a_ringing_push_per_invitee() {
    use crate::push::router::decode_intent;
    use frick_protocol::calls::{
        CallInviteRecord, CallInviteState, CallKind, CallRoomRecord, CallRoomState,
    };
    use frick_store::stores::job::ListJobsFilter;

    let hub = test_hub().await;
    let tenant_id = DEFAULT_TENANT_ID;

    let room = CallRoomRecord {
        id: "call-1".into(),
        conversation_id: "conv-9".into(),
        state: CallRoomState::Ringing,
        created_by: "alice".into(),
        kind: CallKind::Video,
        created_at: "1970-01-01T00:00:00.000Z".into(),
        started_at: None,
        ended_at: None,
        media_session_id: None,
        transport: None,
    };
    let invite = |id: &str, invitee: &str| CallInviteRecord {
        id: id.into(),
        call_id: room.id.clone(),
        invitee_user_id: invitee.into(),
        status: CallInviteState::Ringing,
        invited_by: room.created_by.clone(),
        invited_at: room.created_at.clone(),
        responded_at: None,
    };
    let invites = vec![invite("inv-1", "bob"), invite("inv-2", "carol")];

    enqueue_ringing_push(&hub, tenant_id, &room, &invites).await;

    // One durable `push.deliver` job per invitee landed in the store.
    let jobs = hub
        .state
        .store
        .jobs()
        .list(&ListJobsFilter {
            tenant_id: Some(tenant_id.to_string()),
            job_type: Some("push.deliver".to_string()),
            ..ListJobsFilter::default()
        })
        .await
        .unwrap();
    assert_eq!(jobs.len(), 2, "one ringing push per invitee");

    // Decode each job payload back into an intent and check the per-invitee shape.
    let mut recipients: Vec<String> = Vec::new();
    for job in &jobs {
        let intent = decode_intent(&job.payload).expect("a valid push.deliver intent");
        assert_eq!(intent.intent, "call.ringing");
        assert_eq!(intent.tenant_id, tenant_id);
        assert_eq!(intent.recipient_user_ids.len(), 1);
        let recipient = intent.recipient_user_ids[0].clone();
        // Title/body reference the creator.
        assert_eq!(intent.body.title.as_deref(), Some("Incoming call"));
        assert_eq!(intent.body.body.as_deref(), Some("alice is calling you"));
        // data carries { type, callId, conversationId, createdBy }.
        let Some(Value::Map(data)) = intent.body.data.as_ref() else {
            panic!("ringing push must carry a data map");
        };
        let field = |key: &str| -> Option<&str> {
            data.iter()
                .find(|(k, _)| k.as_str() == Some(key))
                .and_then(|(_, v)| v.as_str())
        };
        assert_eq!(field("type"), Some("callRinging"));
        assert_eq!(field("callId"), Some("call-1"));
        assert_eq!(field("conversationId"), Some("conv-9"));
        assert_eq!(field("createdBy"), Some("alice"));
        // Ringing pushes for one call are grouped by the call id.
        assert_eq!(intent.thread_id.as_deref(), Some("call-1"));
        recipients.push(recipient);
    }
    recipients.sort();
    assert_eq!(recipients, vec!["bob".to_string(), "carol".to_string()]);
}

/// AURA-317 — the ring path itself (a real `CallCommand::Create` frame through
/// [`handle_raw_frame`]/[`handle_call_command`], not the [`enqueue_ringing_push`]
/// helper directly) ends with a durable `push.deliver` job for the invitee,
/// while the creator still gets their ordinary `CallCommandResult` frame.
/// Proves the trigger is really wired into the control-plane's create path, and
/// that emitting the push intent is metadata-only + doesn't disturb the normal
/// call-command reply.
#[tokio::test]
async fn call_command_create_frame_triggers_a_ringing_push_job() {
    use frick_protocol::calls::{CallCommandName, CallCommandOp, CallCommandPayload};
    use frick_store::stores::job::ListJobsFilter;

    let hub = test_hub_with_schema(crate::calls::schema::build_call_schema()).await;
    let creator = tenant_principal("ada", DEFAULT_TENANT_ID);
    let (creator_id, mut creator_rx) = register_test_connection(&hub, Some(creator), None);

    let create = FrickFrame::CallCommand(CallCommandPayload {
        request_id: "req-create-1".into(),
        command: CallCommandOp::Create {
            conversation_id: "conv-42".into(),
            invitee_user_ids: vec!["grace".into()],
            kind: None,
            region_hint: None,
        },
    });
    let bytes = encode_frame(&create).unwrap();
    let closed = super::handle_raw_frame(&hub, creator_id, &bytes).await;
    assert!(!closed);

    // The creator still gets the ordinary CallCommandResult — the push trigger
    // is a side-channel, not a replacement reply.
    let out = creator_rx.try_recv().expect("a reply frame");
    let super::Outbound::Frame(bytes) = out else {
        panic!("expected a frame");
    };
    let FrickFrame::CallCommandResult(result) = decode_frame(&bytes).unwrap() else {
        panic!("expected a CallCommandResult");
    };
    assert_eq!(result.request_id, "req-create-1");
    assert_eq!(result.op, CallCommandName::Create);
    let room = result.room.expect("create result carries the room");
    let call_id = room.id.clone();

    // A durable push.deliver job landed for grace's ringing push, decoding to
    // a call.ringing intent keyed on the real call id the control plane minted.
    let jobs = hub
        .state
        .store
        .jobs()
        .list(&ListJobsFilter {
            tenant_id: Some(DEFAULT_TENANT_ID.to_string()),
            job_type: Some("push.deliver".to_string()),
            ..ListJobsFilter::default()
        })
        .await
        .unwrap();
    assert_eq!(jobs.len(), 1, "one ringing push for the lone invitee");
    let intent =
        crate::push::router::decode_intent(&jobs[0].payload).expect("a valid push.deliver intent");
    assert_eq!(intent.intent, "call.ringing");
    assert_eq!(intent.recipient_user_ids, vec!["grace".to_string()]);
    assert_eq!(intent.thread_id.as_deref(), Some(call_id.as_str()));
    let Some(Value::Map(data)) = intent.body.data.as_ref() else {
        panic!("ringing push must carry a data map");
    };
    // Metadata-only: no message/call-content field, just routing data.
    let flat = format!("{data:?}").to_lowercase();
    for banned in ["ciphertext", "plaintext", "sdp", "\"offer\"", "\"answer\""] {
        assert!(
            !flat.contains(banned),
            "push data leaked `{banned}`: {flat}"
        );
    }
    assert!(
        data.iter()
            .any(|(k, v)| k.as_str() == Some("callId") && v.as_str() == Some(call_id.as_str()))
    );
}

// ---- CallDataChannel relay (AURA-316) ---------------------------------------

/// AURA-316: `CallDataChannel` (reactions/raise-hand/captions) rides the
/// generic `SignalSend`/`SignalDeliver` primitive, reusing the exact FR-284
/// call-membership gate already proven for `WebRTCSignal` — no new authz
/// surface, no touching the framework-reserved `CallCommandOp`/object types.
/// A call member (creator or invitee) may relay a data-channel envelope; an
/// outsider is rejected with the same `notMember` Nack shape as the signaling
/// relay.
#[tokio::test]
async fn call_data_channel_relay_is_gated_on_call_membership_like_webrtc_signal() {
    use frick_protocol::frame::SignalPayload;

    // The default `test_hub()` schema (`Note`-only) has no `CallRoom`/
    // `CallInvite` object types, so `create_call` would fail to persist; use
    // the real call schema instead (same one `CallControlPlane`'s own unit
    // tests build against).
    let hub = test_hub_with_schema(crate::calls::schema::build_call_schema()).await;

    let creator = tenant_principal("ada", DEFAULT_TENANT_ID);
    let outsider = tenant_principal("mallory", DEFAULT_TENANT_ID);
    let (creator_id, mut creator_rx) = register_test_connection(&hub, Some(creator), None);
    let (outsider_id, mut outsider_rx) = register_test_connection(&hub, Some(outsider), None);

    // Create a call with ada as creator and grace as the lone invitee (grace
    // never connects here; only membership bookkeeping is under test).
    let created = hub
        .state
        .calls
        .create_call(
            &crate::calls::call_actor("ada", "dev-a"),
            crate::calls::CreateCallInput {
                conversation_id: "conv-1".into(),
                invitee_user_ids: vec!["grace".into()],
                kind: None,
                region_hint: None,
            },
        )
        .await
        .expect("create call");
    let call_id = created.room.id.clone();

    // The creator (a call member) relays a reaction — it is accepted (Ack),
    // not Nacked.
    let reaction = FrickFrame::SignalSend(SignalPayload {
        request_id: "req-reaction-1".into(),
        name: crate::calls::schema::CALL_DATA_CHANNEL.to_string(),
        key: call_id.clone(),
        value: Value::Map(vec![
            ("kind".into(), "reaction".into()),
            ("emoji".into(), "🎉".into()),
        ]),
    });
    let bytes = encode_frame(&reaction).unwrap();
    let closed = super::handle_raw_frame(&hub, creator_id, &bytes).await;
    assert!(!closed);
    let out = creator_rx.try_recv().expect("a reply frame");
    let super::Outbound::Frame(bytes) = out else {
        panic!("expected a frame");
    };
    match decode_frame(&bytes).unwrap() {
        FrickFrame::Ack(ack) => assert_eq!(ack.request_id, "req-reaction-1"),
        other => panic!("expected an Ack for a member's relay, got {other:?}"),
    }

    // An outsider (never invited, never joined) relaying on the same call id
    // is rejected with the identical `notMember` Nack the WebRTCSignal gate
    // uses (FR-284) — same seam, same failure shape.
    let hijack = FrickFrame::SignalSend(SignalPayload {
        request_id: "req-reaction-2".into(),
        name: crate::calls::schema::CALL_DATA_CHANNEL.to_string(),
        key: call_id.clone(),
        value: Value::Map(vec![("kind".into(), "raiseHand".into())]),
    });
    let bytes = encode_frame(&hijack).unwrap();
    let closed = super::handle_raw_frame(&hub, outsider_id, &bytes).await;
    assert!(!closed);
    let out = outsider_rx.try_recv().expect("a reply frame");
    let super::Outbound::Frame(bytes) = out else {
        panic!("expected a frame");
    };
    let FrickFrame::Nack(nack) = decode_frame(&bytes).unwrap() else {
        panic!("expected a nack for a non-member's relay");
    };
    assert_eq!(nack.error.code, FrickErrorCode::AuthForbidden);
    let Some(Value::Map(details)) = &nack.error.details else {
        panic!("details map");
    };
    assert!(
        details
            .iter()
            .any(|(k, v)| k.as_str() == Some("reason") && v.as_str() == Some("notMember")),
        "expected reason:notMember, got {details:?}"
    );

    // A completely unrelated signal name (not WebRTCSignal or CallDataChannel)
    // is never subject to the call-membership gate at all — the outsider's
    // relay on an arbitrary signal succeeds.
    let unrelated = FrickFrame::SignalSend(SignalPayload {
        request_id: "req-unrelated".into(),
        name: "SomeOtherSignal".into(),
        key: call_id,
        value: Value::Map(vec![]),
    });
    let bytes = encode_frame(&unrelated).unwrap();
    let closed = super::handle_raw_frame(&hub, outsider_id, &bytes).await;
    assert!(!closed);
    let out = outsider_rx.try_recv().expect("a reply frame");
    let super::Outbound::Frame(bytes) = out else {
        panic!("expected a frame");
    };
    match decode_frame(&bytes).unwrap() {
        FrickFrame::Ack(ack) => assert_eq!(ack.request_id, "req-unrelated"),
        other => panic!("expected an Ack for an ungated signal, got {other:?}"),
    }
}

// ---- helpers ----------------------------------------------------------------

fn test_config() -> FrickConfig {
    let mut env = BTreeMap::new();
    env.insert("FRICK_ENV".to_string(), "test".to_string());
    env.insert("FRICK_DB_PATH".to_string(), ":memory:".to_string());
    env.insert("FRICK_PORT".to_string(), "0".to_string());
    load_frick_config(&env).unwrap()
}

/// A hub over a fresh in-memory `Note`-schema state (no listening socket).
async fn test_hub() -> std::sync::Arc<GatewayHub> {
    test_hub_with_schema(note_schema()).await
}

async fn test_hub_with_schema(schema: FrickSchema) -> std::sync::Arc<GatewayHub> {
    test_hub_with_lifecycle(schema, std::sync::Arc::new(Vec::new())).await
}

async fn test_hub_with_lifecycle(
    schema: FrickSchema,
    connection_lifecycle: super::ConnectionLifecycleHooks,
) -> std::sync::Arc<GatewayHub> {
    test_hub_with_seams(
        schema,
        connection_lifecycle,
        std::sync::Arc::new(Vec::new()),
    )
    .await
}

async fn test_hub_with_seams(
    schema: FrickSchema,
    connection_lifecycle: super::ConnectionLifecycleHooks,
    federation_hooks: crate::federation::FederationHooks,
) -> std::sync::Arc<GatewayHub> {
    let store = std::sync::Arc::new(
        frick_store::FrickStore::open(frick_store::FrickStoreOptions {
            schema: Some(schema.clone()),
            ..frick_store::FrickStoreOptions::default()
        })
        .await
        .unwrap(),
    );
    let push = crate::push::build_push_subsystem(
        std::sync::Arc::clone(&store),
        std::sync::Arc::new(crate::push::SystemPushClock),
        std::sync::Arc::new(crate::push::NoopTelemetry),
        std::sync::Arc::new(crate::push::credentials::ProcessCredentialEnv),
        push_transports_for_test(),
    );
    let projections = crate::projections::ProjectionRegistry::new();
    let search = crate::search::SearchRegistry::new();
    let apps = std::sync::Arc::new(
        crate::apps::FrickAppRegistry::new(vec![crate::apps::AppEntry {
            id: crate::principal::DEFAULT_APP_ID.to_string(),
            base_path: String::new(),
            schema: schema.clone(),
            projections: projections.clone(),
            search: search.clone(),
        }])
        .unwrap(),
    );
    let calls = std::sync::Arc::new(crate::calls::CallControlPlane::new(
        std::sync::Arc::clone(&store),
        std::sync::Arc::new(crate::calls::FakeMediaPlaneAdapter::sfu()),
        std::sync::Arc::new(crate::calls::SystemCallClock),
    ));
    let state = std::sync::Arc::new(AppStateInner {
        config: test_config(),
        store,
        schema,
        started_at: "1970-01-01T00:00:00.000Z".into(),
        auth_limiter: std::sync::Mutex::new(crate::http::AuthLimiter::default()),
        projections,
        search,
        push_registry: push.registry,
        notification_router: push.router,
        email_router: std::sync::Arc::new(crate::email::EmailRouter::noop()),
        auth_lifecycle: std::sync::Arc::new(crate::auth_lifecycle::NoopAuthLifecycle),
        apps,
        gateway: std::sync::OnceLock::new(),
        calls,
        blob_processors: std::sync::Arc::new(crate::blob_processors::BlobProcessorRegistry::new()),
        platform_events: std::sync::Arc::new(frick_store::MemoryPlatformEvents::new()),
        policy_hooks: std::sync::Arc::new(Vec::new()),
        connection_lifecycle,
        federation_hooks,
        write_side_effects: Vec::new(),
    });
    let hub = GatewayHub::new(state);
    hub.state.attach_gateway(&hub);
    hub
}

/// Inert push transports for the gateway tests (these tests never deliver a
/// push; the wiring just has to construct). The live reqwest transports would
/// also work but allocate clients needlessly.
fn push_transports_for_test() -> crate::push::PushTransports {
    use crate::push::apns_adapter::UnavailableApnsTransport;
    use crate::push::fcm_adapter::UnavailableFcmTransport;
    use crate::push::webpush_adapter::UnavailableWebPushTransport;
    crate::push::PushTransports {
        apns: std::sync::Arc::new(UnavailableApnsTransport),
        fcm: std::sync::Arc::new(UnavailableFcmTransport),
        web_push: std::sync::Arc::new(UnavailableWebPushTransport),
    }
}

/// A minimal valid schema with one object type `Note { id, body }`.
fn note_schema() -> FrickSchema {
    FrickSchema {
        name: "note-app".into(),
        schema_id: "note-app".into(),
        schema_version: "0.1.0".into(),
        schema_revision: 1,
        minimum_client_revision: 1,
        minimum_server_revision: 1,
        protocol: "frick.realtime".into(),
        protocol_version: 1,
        compatibility: "greenfield-cutover".into(),
        hash: "note-app-hash-0.1.0".into(),
        objects: vec![ObjectDef {
            id: 1,
            name: "Note".into(),
            fields: vec![
                FieldDef {
                    id: 1,
                    name: "id".into(),
                    kind: FieldKind::Id,
                    required: true,
                    ref_: None,
                    enum_values: None,
                    sensitivity: None,
                },
                FieldDef {
                    id: 2,
                    name: "body".into(),
                    kind: FieldKind::String,
                    required: false,
                    ref_: None,
                    enum_values: None,
                    sensitivity: None,
                },
            ],
            indexes: vec![],
            merge_policy: None,
        }],
        streams: vec![],
        events: vec![],
        presences: vec![],
        signals: vec![],
        blobs: vec![],
        jobs: vec![],
        projections: vec![],
    }
}

fn note_value(id: &str, body: &str) -> Value {
    Value::Map(vec![
        ("id".into(), Value::from(id)),
        ("body".into(), Value::from(body)),
    ])
}

// ---- per-record object read scoping (FR-235/FR-116/FR-234) -------------------

/// A schema whose `OwnedNote` type declares the `ownerUserId` owner-field
/// convention, so reads are owner-scoped (relaxable by sharing grants).
fn owned_note_schema() -> FrickSchema {
    let mut schema = note_schema();
    schema.objects = vec![ObjectDef {
        id: 1,
        name: "OwnedNote".into(),
        fields: vec![
            FieldDef {
                id: 1,
                name: "id".into(),
                kind: FieldKind::Id,
                required: true,
                ref_: None,
                enum_values: None,
                sensitivity: None,
            },
            FieldDef {
                id: 2,
                name: "body".into(),
                kind: FieldKind::String,
                required: false,
                ref_: None,
                enum_values: None,
                sensitivity: None,
            },
            FieldDef {
                id: 3,
                name: "ownerUserId".into(),
                kind: FieldKind::String,
                required: false,
                ref_: None,
                enum_values: None,
                sensitivity: None,
            },
        ],
        indexes: vec![],
        merge_policy: None,
    }];
    schema
}

fn owned_note_value(id: &str, body: &str, owner: &str) -> Value {
    Value::Map(vec![
        ("id".into(), Value::from(id)),
        ("body".into(), Value::from(body)),
        ("ownerUserId".into(), Value::from(owner)),
    ])
}

/// Register a connection for `user` subscribed to `OwnedNote`.
fn register_owned_note_sub(
    hub: &std::sync::Arc<GatewayHub>,
    user: &str,
) -> (u64, tokio::sync::mpsc::UnboundedReceiver<super::Outbound>) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<super::Outbound>();
    let id = hub.register(super::Connection {
        principal: Some(tenant_principal(user, DEFAULT_TENANT_ID)),
        session_token: None,
        app_id: DEFAULT_APP_ID.to_string(),
        handshake_complete: true,
        subscriptions: [super::SubKey {
            subscription_id: format!("sub-{user}"),
            kind: SubscriptionKind::Object,
            name: "OwnedNote".into(),
            key: None,
        }]
        .into_iter()
        .collect(),
        pending_writes: 0,
        outbound: tx,
    });
    (id, rx)
}

async fn create_read_grant(
    hub: &std::sync::Arc<GatewayHub>,
    owner: &str,
    grantee: &str,
    record_type: &str,
    record_id: &str,
) {
    hub.state
        .store
        .grants()
        .create(&frick_store::stores::grant::CreateGrantArgs {
            id: format!("grant-{grantee}-{record_id}"),
            tenant_id: DEFAULT_TENANT_ID.to_string(),
            owner_user_id: owner.into(),
            record_type: record_type.into(),
            record_id: record_id.into(),
            grantee_user_id: grantee.into(),
            permission: "read".into(),
            created_at: "1970-01-01T00:00:00.000Z".into(),
        })
        .await
        .unwrap();
}

fn upsert_owned_note(
    tenant_id: &str,
    app_id: &str,
    id: &str,
    object: &Value,
) -> FrickStoreWriteEvent {
    FrickStoreWriteEvent::ObjectUpsert {
        tenant_id: tenant_id.to_string(),
        app_id: app_id.to_string(),
        object_type: "OwnedNote".into(),
        object_id: id.to_string(),
        object: object.clone(),
        writer_user_id: None,
    }
}

#[test]
fn fan_out_owner_scoped_skips_non_owner() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let hub = test_hub_with_schema(owned_note_schema()).await;
        let (_a, mut rx_a) = register_owned_note_sub(&hub, "ada");
        let (_b, mut rx_b) = register_owned_note_sub(&hub, "bo");

        // ada writes a row she owns.
        let mut event = upsert_owned_note(
            DEFAULT_TENANT_ID,
            DEFAULT_APP_ID,
            "n1",
            &owned_note_value("n1", "secret", "ada"),
        );
        if let FrickStoreWriteEvent::ObjectUpsert { writer_user_id, .. } = &mut event {
            *writer_user_id = Some("ada".into());
        }
        hub.handle_store_write(&event);

        // The owner receives the delta inline; the non-owner (no grant) does not.
        assert!(
            matches!(rx_a.try_recv(), Ok(super::Outbound::Frame(_))),
            "owner must receive her own row"
        );
        assert!(
            rx_b.try_recv().is_err(),
            "a non-owner with no grant must not receive an owner-scoped row"
        );
    });
}

#[test]
fn fan_out_writer_echo_reaches_writer_despite_owner_mismatch() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let hub = test_hub_with_schema(owned_note_schema()).await;
        let (_b, mut rx_b) = register_owned_note_sub(&hub, "bo");

        // The row is owned by "ada" but written by "bo" (e.g. ownership transfer).
        // The writer's own subscription still receives the echo (FR-234).
        let mut event = upsert_owned_note(
            DEFAULT_TENANT_ID,
            DEFAULT_APP_ID,
            "n1",
            &owned_note_value("n1", "x", "ada"),
        );
        if let FrickStoreWriteEvent::ObjectUpsert { writer_user_id, .. } = &mut event {
            *writer_user_id = Some("bo".into());
        }
        hub.handle_store_write(&event);

        assert!(
            matches!(rx_b.try_recv(), Ok(super::Outbound::Frame(_))),
            "the writer must receive its own write echo"
        );
    });
}

#[test]
fn fan_out_grant_relaxation_reaches_grantee() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let hub = test_hub_with_schema(owned_note_schema()).await;
        let (_b, mut rx_b) = register_owned_note_sub(&hub, "bo");
        // ada shares n1 with bo (read).
        create_read_grant(&hub, "ada", "bo", "OwnedNote", "n1").await;

        let mut event = upsert_owned_note(
            DEFAULT_TENANT_ID,
            DEFAULT_APP_ID,
            "n1",
            &owned_note_value("n1", "shared", "ada"),
        );
        if let FrickStoreWriteEvent::ObjectUpsert { writer_user_id, .. } = &mut event {
            *writer_user_id = Some("ada".into());
        }
        hub.handle_store_write(&event);

        // The grantee receives the delta — resolved asynchronously off the hot path.
        let frame = tokio::time::timeout(Duration::from_secs(2), rx_b.recv())
            .await
            .expect("grantee delta within timeout")
            .expect("a frame");
        assert!(matches!(frame, super::Outbound::Frame(_)));
    });
}

#[test]
fn visibility_revoked_drops_row_for_non_reader_keeps_it_for_owner() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let hub = test_hub_with_schema(owned_note_schema()).await;
        let owned = owned_note_value("n1", "shared", "ada");
        hub.state
            .store
            .objects()
            .upsert(
                DEFAULT_TENANT_ID,
                "OwnedNote",
                "n1",
                &owned,
                1,
                DEFAULT_APP_ID,
                0,
            )
            .await
            .unwrap();

        let (_a, mut rx_a) = register_owned_note_sub(&hub, "ada");
        let (_b, mut rx_b) = register_owned_note_sub(&hub, "bo");

        // Re-evaluate visibility (as a revoke would): bo holds no grant and is
        // not the owner, so the row must disappear for bo but not for ada.
        hub.fan_out_object_visibility_revoked(DEFAULT_TENANT_ID, DEFAULT_APP_ID, "OwnedNote", "n1")
            .await;

        assert!(
            rx_a.try_recv().is_err(),
            "the owner keeps the row (no removal)"
        );
        let super::Outbound::Frame(bytes) = rx_b.try_recv().expect("a removal for the non-reader")
        else {
            panic!("expected a frame");
        };
        let FrickFrame::Delta(delta) = decode_frame(&bytes).unwrap() else {
            panic!("expected a delta");
        };
        assert!(
            delta.removed.is_some_and(|r| !r.is_empty()),
            "the removal Delta carries a removed marker"
        );
    });
}

/// End-to-end: a fresh subscriber's initial Snapshot is owner-scoped — it
/// carries only the rows the subscriber may read, never another user's
/// owner-scoped rows (FR-235/FR-116). This is the largest exposure surface:
/// before the fix the snapshot dumped every tenant row to every subscriber.
#[tokio::test]
async fn ws_snapshot_is_owner_scoped() {
    use futures_util::SinkExt;

    let schema = owned_note_schema();
    let mut server = create_frick_server(test_config(), schema.clone())
        .await
        .unwrap();
    let hub = GatewayHub::new(std::sync::Arc::clone(&server.state));
    server.state.store.set_write_listener(hub.write_listener());

    // Seed two owners' rows directly in the store.
    server
        .state
        .store
        .objects()
        .upsert(
            DEFAULT_TENANT_ID,
            "OwnedNote",
            "ada-1",
            &owned_note_value("ada-1", "mine", "user-ada"),
            1,
            DEFAULT_APP_ID,
            0,
        )
        .await
        .unwrap();
    server
        .state
        .store
        .objects()
        .upsert(
            DEFAULT_TENANT_ID,
            "OwnedNote",
            "bo-1",
            &owned_note_value("bo-1", "hers", "user-bo"),
            1,
            DEFAULT_APP_ID,
            0,
        )
        .await
        .unwrap();

    let app = hub.router();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let _serve = tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });

    let http_port = server.listen().await.unwrap();
    let token = dev_login_token(http_port, "user-ada").await;

    let url = format!("ws://127.0.0.1:{port}/_frick/sync");
    let (mut socket, _response) = tokio_tungstenite::connect_async(&url).await.unwrap();

    let hello = FrickFrame::Hello(Box::new(HelloPayload {
        replica_id: "replica-1".into(),
        device_id: "device-1".into(),
        schema_hash: schema.hash.clone(),
        known_cursors: std::iter::empty::<(String, i64)>().collect(),
        session_token: Some(token),
        client_capabilities: None,
    }));
    socket
        .send(TungMessage::Binary(encode_frame(&hello).unwrap()))
        .await
        .unwrap();
    let ack = next_frame(&mut socket).await;
    assert!(matches!(ack, FrickFrame::HelloAck(_)), "got {ack:?}");
    let schema_frame = next_frame(&mut socket).await;
    assert!(
        matches!(schema_frame, FrickFrame::Schema(_)),
        "got {schema_frame:?}"
    );

    let subscribe = FrickFrame::Subscribe(SubscribePayload {
        subscription_id: "sub-owned".into(),
        kind: SubscriptionKind::Object,
        name: "OwnedNote".into(),
        key: None,
        cursor: None,
    });
    socket
        .send(TungMessage::Binary(encode_frame(&subscribe).unwrap()))
        .await
        .unwrap();
    let snapshot = next_frame(&mut socket).await;
    let FrickFrame::Snapshot(snapshot) = snapshot else {
        panic!("expected snapshot, got {snapshot:?}");
    };
    // ada sees only her own row — bo's owner-scoped row is filtered out.
    assert_eq!(snapshot.objects.len(), 1, "snapshot must be owner-scoped");
    assert_eq!(snapshot.objects[0].1, "ada-1");
}

/// Read the next frame off the socket, ignoring server pings.
async fn next_frame(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> FrickFrame {
    use futures_util::StreamExt;
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("frame within timeout")
            .expect("a message")
            .expect("an ok message");
        match message {
            TungMessage::Binary(bytes) => {
                let frame = decode_frame(&bytes).unwrap();
                // The heartbeat may inject server→client Pings; skip them.
                if matches!(frame, FrickFrame::Ping(_)) {
                    continue;
                }
                return frame;
            }
            TungMessage::Ping(_) | TungMessage::Pong(_) => {}
            TungMessage::Close(frame) => panic!("socket closed: {frame:?}"),
            other => panic!("unexpected ws message {other:?}"),
        }
    }
}

/// Dev-login over the HTTP surface, returning the session token.
async fn dev_login_token(port: u16, user_id: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let body = format!(r#"{{"userId":"{user_id}"}}"#);
    let mut stream = tokio::net::TcpStream::connect(format!("127.0.0.1:{port}"))
        .await
        .unwrap();
    let request = format!(
        "POST /auth/dev-login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    let needle = "\"sessionToken\":\"";
    let start = response.find(needle).expect("token present") + needle.len();
    let rest = &response[start..];
    let end = rest.find('"').expect("closing quote");
    rest[..end].to_string()
}
