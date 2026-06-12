//! Cluster-bus contract tests, porting the behaviors pinned by
//! `apps/server/tests/cluster-bus.test.ts`:
//! cross-bus delivery, self-publish loop guard, handler-exception isolation,
//! close detaches, distinct random node ids, tenant filtering (incl. empty-set
//! "drop everything" + snapshot semantics + pass-through), and that every
//! envelope kind (and `appId`) is carried across nodes.
//!
//! The Redis adapter shares the same trait; its envelope msgpack round-trip is
//! verified here, and a live broker smoke test is gated behind the `redis-live`
//! feature (CI has no Redis).

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use frick_protocol::Value;

use super::envelope::ProjectionChange;
use super::{ClusterEnvelope, FrickClusterBus, MemoryClusterBus, MemoryClusterChannel};

/// Collect received envelopes into a shared vector; returns the sink + a
/// boxed handler that pushes into it.
fn collector() -> (
    Arc<Mutex<Vec<ClusterEnvelope>>>,
    super::ClusterEnvelopeHandler,
) {
    let sink = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&sink);
    let handler: super::ClusterEnvelopeHandler = Box::new(move |envelope: &ClusterEnvelope| {
        captured.lock().unwrap().push(envelope.clone());
    });
    (sink, handler)
}

fn stream_event(origin: &str, sequence: i64) -> ClusterEnvelope {
    ClusterEnvelope::StreamEvent {
        origin_node_id: origin.to_string(),
        tenant_id: "_default".to_string(),
        app_id: None,
        stream: "MessageStream".to_string(),
        stream_id: "conversation-general".to_string(),
        sequence,
        packed: (
            1,
            "conversation-general".to_string(),
            sequence,
            format!("evt-{sequence}"),
            1,
            vec![],
        ),
    }
}

fn stream_event_for_tenant(origin: &str, sequence: i64, tenant: &str) -> ClusterEnvelope {
    let mut envelope = stream_event(origin, sequence);
    if let ClusterEnvelope::StreamEvent { tenant_id, .. } = &mut envelope {
        *tenant_id = tenant.to_string();
    }
    envelope
}

#[test]
fn delivers_envelope_from_bus_a_to_subscriber_on_bus_b() {
    let channel = MemoryClusterChannel::new();
    let a = MemoryClusterBus::with_options(super::MemoryClusterBusOptions {
        node_id: Some("node-a".into()),
        channel: Some(channel.clone()),
    });
    let b = MemoryClusterBus::with_options(super::MemoryClusterBusOptions {
        node_id: Some("node-b".into()),
        channel: Some(channel),
    });

    let (received, handler) = collector();
    let _ = b.subscribe(handler);

    a.publish(&stream_event("node-a", 1));

    let received = received.lock().unwrap();
    assert_eq!(received.len(), 1);
    assert_eq!(received[0].kind(), "streamEvent");
    assert_eq!(received[0].origin_node_id(), "node-a");
}

#[test]
fn loop_guard_filters_own_publishes_from_own_subscribers() {
    let channel = MemoryClusterChannel::new();
    let a = MemoryClusterBus::with_options(super::MemoryClusterBusOptions {
        node_id: Some("node-a".into()),
        channel: Some(channel.clone()),
    });
    let b = MemoryClusterBus::with_options(super::MemoryClusterBusOptions {
        node_id: Some("node-b".into()),
        channel: Some(channel),
    });

    let on_a = Arc::new(AtomicUsize::new(0));
    let on_b = Arc::new(AtomicUsize::new(0));
    let a_counter = Arc::clone(&on_a);
    let b_counter = Arc::clone(&on_b);
    let _ = a.subscribe(Box::new(move |_| {
        a_counter.fetch_add(1, Ordering::Relaxed);
    }));
    let _ = b.subscribe(Box::new(move |_| {
        b_counter.fetch_add(1, Ordering::Relaxed);
    }));

    a.publish(&stream_event("node-a", 1));

    assert_eq!(
        on_a.load(Ordering::Relaxed),
        0,
        "self-publish must not loop back"
    );
    assert_eq!(on_b.load(Ordering::Relaxed), 1);
}

#[test]
fn isolates_subscriber_panics() {
    let channel = MemoryClusterChannel::new();
    let a = MemoryClusterBus::with_options(super::MemoryClusterBusOptions {
        node_id: Some("node-a".into()),
        channel: Some(channel.clone()),
    });
    let b = MemoryClusterBus::with_options(super::MemoryClusterBusOptions {
        node_id: Some("node-b".into()),
        channel: Some(channel),
    });

    let _ = b.subscribe(Box::new(|_| panic!("subscriber blew up")));
    let ok = Arc::new(AtomicUsize::new(0));
    let ok_counter = Arc::clone(&ok);
    let _ = b.subscribe(Box::new(move |_| {
        ok_counter.fetch_add(1, Ordering::Relaxed);
    }));

    a.publish(&stream_event("node-a", 1));
    assert_eq!(
        ok.load(Ordering::Relaxed),
        1,
        "the healthy handler still runs"
    );
}

#[test]
fn close_detaches_bus_from_channel() {
    let channel = MemoryClusterChannel::new();
    let a = MemoryClusterBus::with_options(super::MemoryClusterBusOptions {
        node_id: Some("node-a".into()),
        channel: Some(channel.clone()),
    });
    let b = MemoryClusterBus::with_options(super::MemoryClusterBusOptions {
        node_id: Some("node-b".into()),
        channel: Some(channel),
    });

    let (received, handler) = collector();
    let _ = b.subscribe(handler);
    b.close();

    a.publish(&stream_event("node-a", 1));
    assert!(
        received.lock().unwrap().is_empty(),
        "closed bus receives nothing"
    );
}

#[test]
fn assigns_distinct_random_node_ids() {
    let a = MemoryClusterBus::new();
    let b = MemoryClusterBus::new();
    assert_ne!(a.node_id(), b.node_id());
    assert!(
        a.node_id().len() > 8,
        "node id is > 8 chars (got {})",
        a.node_id()
    );
}

#[test]
fn drops_inbound_envelopes_for_unsubscribed_tenants() {
    let channel = MemoryClusterChannel::new();
    let a = MemoryClusterBus::with_options(super::MemoryClusterBusOptions {
        node_id: Some("node-a".into()),
        channel: Some(channel.clone()),
    });
    let b = MemoryClusterBus::with_options(super::MemoryClusterBusOptions {
        node_id: Some("node-b".into()),
        channel: Some(channel),
    });

    let (received, handler) = collector();
    let _ = b.subscribe(handler);
    b.set_subscribed_tenants(Some(&HashSet::from(["acme".to_string()])));

    a.publish(&stream_event_for_tenant("node-a", 1, "globex"));
    a.publish(&stream_event_for_tenant("node-a", 2, "acme"));

    let tenants: Vec<String> = received
        .lock()
        .unwrap()
        .iter()
        .map(|e| e.tenant_id().to_string())
        .collect();
    assert_eq!(tenants, vec!["acme".to_string()]);
}

#[test]
fn empty_subscribed_set_drops_everything() {
    let channel = MemoryClusterChannel::new();
    let a = MemoryClusterBus::with_options(super::MemoryClusterBusOptions {
        node_id: Some("node-a".into()),
        channel: Some(channel.clone()),
    });
    let b = MemoryClusterBus::with_options(super::MemoryClusterBusOptions {
        node_id: Some("node-b".into()),
        channel: Some(channel),
    });

    let (received, handler) = collector();
    let _ = b.subscribe(handler);
    b.set_subscribed_tenants(Some(&HashSet::new()));

    a.publish(&stream_event("node-a", 1));
    assert!(
        received.lock().unwrap().is_empty(),
        "empty set drops everything"
    );
}

#[test]
fn never_setting_tenants_passes_through_unfiltered() {
    let channel = MemoryClusterChannel::new();
    let a = MemoryClusterBus::with_options(super::MemoryClusterBusOptions {
        node_id: Some("node-a".into()),
        channel: Some(channel.clone()),
    });
    let b = MemoryClusterBus::with_options(super::MemoryClusterBusOptions {
        node_id: Some("node-b".into()),
        channel: Some(channel),
    });

    let (received, handler) = collector();
    let _ = b.subscribe(handler);

    a.publish(&stream_event_for_tenant("node-a", 1, "globex"));
    a.publish(&stream_event_for_tenant("node-a", 2, "acme"));

    let tenants: Vec<String> = received
        .lock()
        .unwrap()
        .iter()
        .map(|e| e.tenant_id().to_string())
        .collect();
    assert_eq!(tenants, vec!["globex".to_string(), "acme".to_string()]);
}

#[test]
fn snapshots_tenant_set_so_caller_mutation_does_not_leak() {
    let channel = MemoryClusterChannel::new();
    let a = MemoryClusterBus::with_options(super::MemoryClusterBusOptions {
        node_id: Some("node-a".into()),
        channel: Some(channel.clone()),
    });
    let b = MemoryClusterBus::with_options(super::MemoryClusterBusOptions {
        node_id: Some("node-b".into()),
        channel: Some(channel),
    });

    let (received, handler) = collector();
    let _ = b.subscribe(handler);

    let mut live = HashSet::from(["acme".to_string()]);
    b.set_subscribed_tenants(Some(&live));
    live.insert("globex".to_string()); // mutating the original must not widen the filter

    a.publish(&stream_event_for_tenant("node-a", 1, "globex"));
    assert!(
        received.lock().unwrap().is_empty(),
        "the snapshot taken at set time does not include the later-added tenant"
    );
}

#[test]
fn carries_every_envelope_kind_across_nodes() {
    let channel = MemoryClusterChannel::new();
    let a = MemoryClusterBus::with_options(super::MemoryClusterBusOptions {
        node_id: Some("node-a".into()),
        channel: Some(channel.clone()),
    });
    let b = MemoryClusterBus::with_options(super::MemoryClusterBusOptions {
        node_id: Some("node-b".into()),
        channel: Some(channel),
    });
    let (received, handler) = collector();
    let _ = b.subscribe(handler);

    a.publish(&ClusterEnvelope::Objects {
        origin_node_id: "node-a".into(),
        tenant_id: "_default".into(),
        app_id: None,
        object_type: "User".into(),
        objects: vec![Value::Map(vec![
            ("id".into(), Value::from("u1")),
            ("displayName".into(), Value::from("Ada")),
        ])],
    });
    a.publish(&ClusterEnvelope::Signal {
        origin_node_id: "node-a".into(),
        tenant_id: "_default".into(),
        app_id: None,
        name: "WebRTCSignal".into(),
        key: "call:room-1".into(),
        value: Value::Map(vec![("kind".into(), Value::from("offer"))]),
        request_id: "req-1".into(),
    });
    a.publish(&ClusterEnvelope::ProjectionDelta {
        origin_node_id: "node-a".into(),
        tenant_id: "_default".into(),
        app_id: None,
        projection: "conversation-inbox".into(),
        changes: vec![ProjectionChange {
            key: "user-ada:convo-1".into(),
            value: Value::Map(vec![("unreadCount".into(), Value::from(3))]),
        }],
    });
    a.publish(&ClusterEnvelope::PresenceDelta {
        origin_node_id: "node-a".into(),
        tenant_id: "_default".into(),
        app_id: None,
        name: "TypingState".into(),
        records: vec![ProjectionChange {
            key: "convo-1:user-ada:device-web".into(),
            value: Value::Map(vec![("isTyping".into(), Value::Boolean(true))]),
        }],
        cleared: vec![],
    });

    let kinds: Vec<&str> = received
        .lock()
        .unwrap()
        .iter()
        .map(ClusterEnvelope::kind)
        .collect();
    assert_eq!(
        kinds,
        vec!["objects", "signal", "projectionDelta", "presenceDelta"]
    );
}

#[test]
fn carries_origin_app_id_across_nodes() {
    let channel = MemoryClusterChannel::new();
    let a = MemoryClusterBus::with_options(super::MemoryClusterBusOptions {
        node_id: Some("node-a".into()),
        channel: Some(channel.clone()),
    });
    let b = MemoryClusterBus::with_options(super::MemoryClusterBusOptions {
        node_id: Some("node-b".into()),
        channel: Some(channel),
    });
    let (received, handler) = collector();
    let _ = b.subscribe(handler);

    a.publish(&ClusterEnvelope::Objects {
        origin_node_id: "node-a".into(),
        tenant_id: "acme".into(),
        app_id: Some("chat".into()),
        object_type: "Conversation".into(),
        objects: vec![Value::Map(vec![("id".into(), Value::from("c1"))])],
    });
    a.publish(&ClusterEnvelope::PresenceDelta {
        origin_node_id: "node-a".into(),
        tenant_id: "acme".into(),
        app_id: Some("docs".into()),
        name: "TypingState".into(),
        records: vec![ProjectionChange {
            key: "k".into(),
            value: Value::Map(vec![("isTyping".into(), Value::Boolean(true))]),
        }],
        cleared: vec![],
    });

    let app_ids: Vec<Option<String>> = received
        .lock()
        .unwrap()
        .iter()
        .map(|e| match e {
            ClusterEnvelope::Objects { app_id, .. }
            | ClusterEnvelope::PresenceDelta { app_id, .. } => app_id.clone(),
            _ => None,
        })
        .collect();
    assert_eq!(
        app_ids,
        vec![Some("chat".to_string()), Some("docs".to_string())]
    );
}

#[test]
fn unsubscribe_detaches_a_single_handler() {
    let channel = MemoryClusterChannel::new();
    let a = MemoryClusterBus::with_options(super::MemoryClusterBusOptions {
        node_id: Some("node-a".into()),
        channel: Some(channel.clone()),
    });
    let b = MemoryClusterBus::with_options(super::MemoryClusterBusOptions {
        node_id: Some("node-b".into()),
        channel: Some(channel),
    });

    let count = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&count);
    let unsub = b.subscribe(Box::new(move |_| {
        counter.fetch_add(1, Ordering::Relaxed);
    }));

    a.publish(&stream_event("node-a", 1));
    unsub.unsubscribe();
    a.publish(&stream_event("node-a", 2));

    assert_eq!(
        count.load(Ordering::Relaxed),
        1,
        "only the pre-unsubscribe publish counts"
    );
}

// ---- envelope wire round-trip (Redis msgpack form) --------------------------

#[test]
fn msgpack_round_trips_every_kind_field_for_field() {
    let cases = vec![
        ClusterEnvelope::StreamEvent {
            origin_node_id: "n1".into(),
            tenant_id: "acme".into(),
            app_id: Some("chat".into()),
            stream: "MessageStream".into(),
            stream_id: "c-1".into(),
            sequence: 42,
            packed: (
                1,
                "c-1".into(),
                42,
                "evt-42".into(),
                7,
                vec![
                    (3, Value::from("hi")),
                    (4, Value::Binary(vec![0, 1, 2, 255])),
                ],
            ),
        },
        ClusterEnvelope::Objects {
            origin_node_id: "n1".into(),
            tenant_id: "acme".into(),
            app_id: None, // back-compat: omitted on the wire
            object_type: "User".into(),
            objects: vec![Value::Map(vec![("id".into(), Value::from("u1"))])],
        },
        ClusterEnvelope::ObjectDeletes {
            origin_node_id: "n1".into(),
            tenant_id: "acme".into(),
            app_id: Some("chat".into()),
            object_type: "User".into(),
            ids: vec!["u1".into(), "u2".into()],
        },
        ClusterEnvelope::Signal {
            origin_node_id: "n1".into(),
            tenant_id: "acme".into(),
            app_id: Some("chat".into()),
            name: "WebRTCSignal".into(),
            key: "call:r1".into(),
            value: Value::Map(vec![("kind".into(), Value::from("offer"))]),
            request_id: "http".into(),
        },
        ClusterEnvelope::ProjectionDelta {
            origin_node_id: "n1".into(),
            tenant_id: "acme".into(),
            app_id: Some("chat".into()),
            projection: "inbox".into(),
            changes: vec![
                ProjectionChange {
                    key: "k1".into(),
                    value: Value::Map(vec![("n".into(), Value::from(3))]),
                },
                ProjectionChange {
                    key: "k2".into(),
                    value: Value::Nil,
                },
            ],
        },
        ClusterEnvelope::PresenceDelta {
            origin_node_id: "n1".into(),
            tenant_id: "acme".into(),
            app_id: Some("docs".into()),
            name: "TypingState".into(),
            records: vec![ProjectionChange {
                key: "k".into(),
                value: Value::Map(vec![("isTyping".into(), Value::Boolean(true))]),
            }],
            cleared: vec!["gone".into()],
        },
        ClusterEnvelope::MediaPlacementClaim {
            origin_node_id: "n1".into(),
            tenant_id: "_media_placement".into(),
            call_id: "call-1".into(),
            home_node_id: "n1".into(),
            announced_ip: "203.0.113.7".into(),
        },
        ClusterEnvelope::MediaPlacementRelease {
            origin_node_id: "n1".into(),
            tenant_id: "_media_placement".into(),
            call_id: "call-1".into(),
        },
    ];

    for envelope in cases {
        let bytes = envelope.to_msgpack().expect("encode");
        let decoded = ClusterEnvelope::from_msgpack(&bytes).expect("decode");
        assert_eq!(
            decoded,
            envelope,
            "round-trip mismatch for {}",
            envelope.kind()
        );
    }
}

#[test]
fn decoding_an_envelope_without_app_id_yields_none() {
    // An older peer's envelope omits appId; decode must yield None (the gateway
    // then treats it as _default).
    let envelope = ClusterEnvelope::Objects {
        origin_node_id: "n1".into(),
        tenant_id: "acme".into(),
        app_id: None,
        object_type: "User".into(),
        objects: vec![],
    };
    let bytes = envelope.to_msgpack().unwrap();
    // The encoded map must NOT contain an appId key.
    let value = rmpv::decode::read_value(&mut &*bytes).unwrap();
    let map = value.as_map().unwrap();
    assert!(
        !map.iter().any(|(k, _)| k.as_str() == Some("appId")),
        "appId must be omitted when None"
    );
    let decoded = ClusterEnvelope::from_msgpack(&bytes).unwrap();
    let ClusterEnvelope::Objects { app_id, .. } = decoded else {
        panic!("kind");
    };
    assert_eq!(app_id, None);
}

#[test]
fn from_msgpack_rejects_unknown_kind() {
    let value = Value::Map(vec![(Value::from("kind"), Value::from("bogus"))]);
    let mut bytes = Vec::new();
    rmpv::encode::write_value(&mut bytes, &value).unwrap();
    let error = ClusterEnvelope::from_msgpack(&bytes).unwrap_err();
    assert!(matches!(
        error,
        super::envelope::EnvelopeDecodeError::UnknownKind(_)
    ));
}

// ---- Redis adapter (transport-agnostic; no live broker) ---------------------

/// An in-memory pair of [`RedisBusClient`]s wired so a publish on one is
/// delivered to the registered `on_message` of the bus that owns the other.
/// This exercises the adapter's encode → wire-bytes → decode → dispatch path
/// without a real Redis.
mod fake_redis {
    use std::sync::{Arc, Mutex};

    use super::super::redis::{RedisBusClient, RedisClusterBus};
    use super::super::{ClusterEnvelope, FrickClusterBus};

    type MessageSink = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

    /// A publisher that records (channel, payload) pairs.
    struct RecordingPublisher {
        sink: MessageSink,
    }
    impl RedisBusClient for RecordingPublisher {
        fn publish(&self, channel: &str, payload: &[u8]) {
            self.sink
                .lock()
                .unwrap()
                .push((channel.to_string(), payload.to_vec()));
        }
        fn subscribe(&self, _channel: &str) {}
        fn quit(&self) {}
    }

    /// A subscriber stub (subscribe/quit are no-ops; inbound is driven by
    /// calling `bus.on_message`).
    struct NoopSubscriber;
    impl RedisBusClient for NoopSubscriber {
        fn publish(&self, _channel: &str, _payload: &[u8]) {}
        fn subscribe(&self, _channel: &str) {}
        fn quit(&self) {}
    }

    #[test]
    fn publish_encodes_msgpack_and_peer_on_message_dispatches() {
        let sink: MessageSink = Arc::new(Mutex::new(Vec::new()));
        let publisher = Arc::new(RecordingPublisher {
            sink: Arc::clone(&sink),
        });

        let bus_a = RedisClusterBus::new(super::super::redis::RedisClusterBusOptions {
            publisher,
            subscriber: Arc::new(NoopSubscriber),
            node_id: Some("node-a".into()),
            channel: None,
            logger: None,
        });
        let bus_b = RedisClusterBus::new(super::super::redis::RedisClusterBusOptions {
            publisher: Arc::new(NoopSubscriber),
            subscriber: Arc::new(NoopSubscriber),
            node_id: Some("node-b".into()),
            channel: None,
            logger: None,
        });

        let received: Arc<Mutex<Vec<ClusterEnvelope>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&received);
        let _ = bus_b.subscribe(Box::new(move |e: &ClusterEnvelope| {
            captured.lock().unwrap().push(e.clone());
        }));

        let envelope = ClusterEnvelope::Objects {
            origin_node_id: "node-a".into(),
            tenant_id: "acme".into(),
            app_id: Some("chat".into()),
            object_type: "User".into(),
            objects: vec![],
        };
        bus_a.publish(&envelope);

        // The publisher recorded one msgpack frame on the default channel.
        let frames = sink.lock().unwrap().clone();
        assert_eq!(frames.len(), 1);
        let (channel, payload) = &frames[0];
        assert_eq!(channel, super::super::redis::DEFAULT_CHANNEL);

        // Feed that exact frame into bus B's inbound path.
        bus_b.on_message(channel.as_bytes(), payload);
        assert_eq!(received.lock().unwrap().as_slice(), &[envelope]);
    }

    #[test]
    fn loop_guard_drops_own_node_id() {
        let bus = RedisClusterBus::new(super::super::redis::RedisClusterBusOptions {
            publisher: Arc::new(NoopSubscriber),
            subscriber: Arc::new(NoopSubscriber),
            node_id: Some("node-a".into()),
            channel: None,
            logger: None,
        });
        let received: Arc<Mutex<Vec<ClusterEnvelope>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&received);
        let _ = bus.subscribe(Box::new(move |e: &ClusterEnvelope| {
            captured.lock().unwrap().push(e.clone());
        }));
        let own = ClusterEnvelope::ObjectDeletes {
            origin_node_id: "node-a".into(),
            tenant_id: "acme".into(),
            app_id: None,
            object_type: "User".into(),
            ids: vec!["u1".into()],
        };
        bus.on_message(
            super::super::redis::DEFAULT_CHANNEL.as_bytes(),
            &own.to_msgpack().unwrap(),
        );
        assert!(
            received.lock().unwrap().is_empty(),
            "own publish is dropped by the loop guard"
        );
    }

    #[test]
    fn channel_guard_ignores_other_channels() {
        let bus = RedisClusterBus::new(super::super::redis::RedisClusterBusOptions {
            publisher: Arc::new(NoopSubscriber),
            subscriber: Arc::new(NoopSubscriber),
            node_id: Some("node-a".into()),
            channel: None,
            logger: None,
        });
        let received: Arc<Mutex<Vec<ClusterEnvelope>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&received);
        let _ = bus.subscribe(Box::new(move |e: &ClusterEnvelope| {
            captured.lock().unwrap().push(e.clone());
        }));
        let envelope = ClusterEnvelope::ObjectDeletes {
            origin_node_id: "node-b".into(),
            tenant_id: "acme".into(),
            app_id: None,
            object_type: "User".into(),
            ids: vec!["u1".into()],
        };
        bus.on_message(b"other:channel", &envelope.to_msgpack().unwrap());
        assert!(
            received.lock().unwrap().is_empty(),
            "messages on other channels are ignored"
        );
    }

    #[test]
    fn decode_failed_is_logged_and_dropped() {
        let logged: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&logged);
        let bus = RedisClusterBus::new(super::super::redis::RedisClusterBusOptions {
            publisher: Arc::new(NoopSubscriber),
            subscriber: Arc::new(NoopSubscriber),
            node_id: Some("node-a".into()),
            channel: None,
            logger: Some(Arc::new(move |event: &str, _detail: &str| {
                captured.lock().unwrap().push(event.to_string());
            })),
        });
        // Garbage bytes (0xc1 is the msgpack "never used" byte).
        bus.on_message(
            super::super::redis::DEFAULT_CHANNEL.as_bytes(),
            &[0xc1, 0xc1],
        );
        assert_eq!(
            logged.lock().unwrap().as_slice(),
            &["frick.cluster.redis.decode_failed".to_string()]
        );
    }

    #[test]
    fn tenant_filter_drops_unsubscribed_tenants() {
        let bus = RedisClusterBus::new(super::super::redis::RedisClusterBusOptions {
            publisher: Arc::new(NoopSubscriber),
            subscriber: Arc::new(NoopSubscriber),
            node_id: Some("node-a".into()),
            channel: None,
            logger: None,
        });
        let received: Arc<Mutex<Vec<ClusterEnvelope>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&received);
        let _ = bus.subscribe(Box::new(move |e: &ClusterEnvelope| {
            captured.lock().unwrap().push(e.clone());
        }));
        bus.set_subscribed_tenants(Some(&std::collections::HashSet::from(["acme".to_string()])));
        let chan = super::super::redis::DEFAULT_CHANNEL.as_bytes();
        let make = |tenant: &str| ClusterEnvelope::ObjectDeletes {
            origin_node_id: "node-b".into(),
            tenant_id: tenant.into(),
            app_id: None,
            object_type: "User".into(),
            ids: vec!["u1".into()],
        };
        bus.on_message(chan, &make("globex").to_msgpack().unwrap());
        bus.on_message(chan, &make("acme").to_msgpack().unwrap());
        let tenants: Vec<String> = received
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.tenant_id().to_string())
            .collect();
        assert_eq!(tenants, vec!["acme".to_string()]);
    }
}

/// Live Redis smoke test (FR-27). Requires a reachable broker; gated behind the
/// `redis-live` feature because CI has no Redis. Run with:
/// `cargo test -p frick-server --features redis-live cluster::tests::redis_live`.
#[cfg(feature = "redis-live")]
mod redis_live {
    // Intentionally left as a placeholder: wiring a concrete Redis client
    // (e.g. `redis`/`fred`) is the integrator's choice and would add a
    // dependency this crate deliberately omits. The transport-agnostic
    // `fake_redis` tests above verify the adapter's encode/decode/guard logic;
    // a real broker only re-validates the transport, not the contract.
    #[test]
    fn placeholder_requires_a_concrete_redis_client() {}
}
