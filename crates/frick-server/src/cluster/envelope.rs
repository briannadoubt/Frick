//! [`ClusterEnvelope`] — the wire shape of every fan-out message (`bus.ts:44-122`).
//!
//! A tagged union discriminated by the string field `kind`, with eight
//! variants. **Field names and insertion order match the TS code exactly**
//! (§1.3): when msgpack-encoded (the Redis adapter), the envelope is a msgpack
//! *map* with string keys in object insertion order. Decoders read by key, so
//! order is not load-bearing for interop, but the encoder here preserves it so
//! a Rust node and a TS node produce byte-identical frames.
//!
//! `appId` (FR-153 / tenant-app-isolation-1) is present on the six sync kinds.
//! It is **optional on the wire** for back-compat: an envelope from an older
//! peer decodes with `app_id == None`, which the gateway treats as
//! [`DEFAULT_APP_ID`](crate::principal::DEFAULT_APP_ID). The gateway always
//! sets it when publishing, so new nodes never emit envelopes without it.
//!
//! [`PackedStreamEvent`] is the positional msgpack **array** from
//! [`frick_protocol::codec`], not a map.

use frick_protocol::Value;
use frick_protocol::codec::PackedStreamEvent;
use serde::{Deserialize, Serialize};

/// Stable identifier for a server instance. Defaults to a per-process random
/// id. Compared lexicographically by media placement (§1.7), so any unique
/// string is acceptable.
pub type NodeId = String;

/// One row change in a projection or presence delta (`{ key, value }`).
///
/// `value` is `null` on the wire to signal a removal; in Rust that is
/// `Some(Value::Nil)` after decode (msgpack `nil`), distinct from a field that
/// was simply absent. The TS type is `{ key: string; value: PlainObject | null
/// }`; we keep the value as a dynamic [`Value`] so adapters serialize whatever
/// the payload carried.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectionChange {
    /// Row key.
    pub key: String,
    /// Row value, or [`Value::Nil`] for a removal.
    pub value: Value,
}

/// A presence record (`{ key, value }`) carried in a `presenceDelta` envelope.
/// Same shape as [`ProjectionChange`]; kept distinct for readable call sites.
pub type PresenceRecord = ProjectionChange;

/// Wire shape of every fan-out message. Mirrors the gateway's local publish
/// methods one-to-one so a subscriber on a peer node can dispatch back into the
/// right local publish path.
///
/// Encode/decode go through [`ClusterEnvelope::to_msgpack`] /
/// [`ClusterEnvelope::from_msgpack`] (the Redis wire form) and the serde impls
/// (JSON/debug). The serde representation is an internally-tagged map keyed by
/// `kind`, identical to the TS JSON.
#[derive(Debug, Clone, PartialEq)]
pub enum ClusterEnvelope {
    /// A stream append (`gateway.ts:716-728`).
    StreamEvent {
        origin_node_id: NodeId,
        tenant_id: String,
        /// `None` on the wire ⇒ `_default` at the gateway.
        app_id: Option<String>,
        stream: String,
        stream_id: String,
        sequence: i64,
        packed: PackedStreamEvent,
    },
    /// One or more object upserts (`gateway.ts:735-744`).
    Objects {
        origin_node_id: NodeId,
        tenant_id: String,
        app_id: Option<String>,
        #[allow(clippy::struct_field_names)]
        object_type: String,
        objects: Vec<Value>,
    },
    /// Object deletions (FR-142, `gateway.ts:754-763`).
    ObjectDeletes {
        origin_node_id: NodeId,
        tenant_id: String,
        app_id: Option<String>,
        object_type: String,
        ids: Vec<String>,
    },
    /// A signal delivery (`gateway.ts:1006-1017`). `request_id` defaults to
    /// `"http"` for HTTP-originated signals.
    Signal {
        origin_node_id: NodeId,
        tenant_id: String,
        app_id: Option<String>,
        name: String,
        key: String,
        value: Value,
        request_id: String,
    },
    /// A projection delta (`gateway.ts:627-639`).
    ProjectionDelta {
        origin_node_id: NodeId,
        tenant_id: String,
        app_id: Option<String>,
        projection: String,
        changes: Vec<ProjectionChange>,
    },
    /// A presence delta (set: `gateway.ts:1677-1687`; clear: `1713-1723`).
    PresenceDelta {
        origin_node_id: NodeId,
        tenant_id: String,
        app_id: Option<String>,
        name: String,
        records: Vec<PresenceRecord>,
        cleared: Vec<String>,
    },
    /// Multi-box SFU media-placement claim (FR-154,
    /// `cluster-media-placement.ts:177-186`). `tenant_id` is always the sentinel
    /// `_media_placement`. The gateway ignores this kind — only a media-placement
    /// subscriber handles it.
    MediaPlacementClaim {
        origin_node_id: NodeId,
        tenant_id: String,
        call_id: String,
        /// The node that homes the call's router (== `origin_node_id`).
        home_node_id: NodeId,
        announced_ip: String,
    },
    /// Multi-box SFU media-placement release (FR-154,
    /// `cluster-media-placement.ts:142-149`).
    MediaPlacementRelease {
        origin_node_id: NodeId,
        tenant_id: String,
        call_id: String,
    },
}

impl ClusterEnvelope {
    /// The `kind` discriminator string (the msgpack/JSON tag).
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::StreamEvent { .. } => "streamEvent",
            Self::Objects { .. } => "objects",
            Self::ObjectDeletes { .. } => "objectDeletes",
            Self::Signal { .. } => "signal",
            Self::ProjectionDelta { .. } => "projectionDelta",
            Self::PresenceDelta { .. } => "presenceDelta",
            Self::MediaPlacementClaim { .. } => "mediaPlacementClaim",
            Self::MediaPlacementRelease { .. } => "mediaPlacementRelease",
        }
    }

    /// The `originNodeId` of the publishing node (used by the loop guard).
    #[must_use]
    pub fn origin_node_id(&self) -> &str {
        match self {
            Self::StreamEvent { origin_node_id, .. }
            | Self::Objects { origin_node_id, .. }
            | Self::ObjectDeletes { origin_node_id, .. }
            | Self::Signal { origin_node_id, .. }
            | Self::ProjectionDelta { origin_node_id, .. }
            | Self::PresenceDelta { origin_node_id, .. }
            | Self::MediaPlacementClaim { origin_node_id, .. }
            | Self::MediaPlacementRelease { origin_node_id, .. } => origin_node_id,
        }
    }

    /// The envelope's `tenantId` (used by the inbound tenant filter). For the
    /// two media-placement kinds this is the `_media_placement` sentinel.
    #[must_use]
    pub fn tenant_id(&self) -> &str {
        match self {
            Self::StreamEvent { tenant_id, .. }
            | Self::Objects { tenant_id, .. }
            | Self::ObjectDeletes { tenant_id, .. }
            | Self::Signal { tenant_id, .. }
            | Self::ProjectionDelta { tenant_id, .. }
            | Self::PresenceDelta { tenant_id, .. }
            | Self::MediaPlacementClaim { tenant_id, .. }
            | Self::MediaPlacementRelease { tenant_id, .. } => tenant_id,
        }
    }

    /// Encode to the Redis wire form: `@msgpack`-equivalent bytes of one
    /// envelope — a msgpack map with string keys in the §1.3 insertion order,
    /// `packed` as a nested array. Binary-safe by construction.
    ///
    /// # Errors
    /// Returns an error only if the underlying msgpack writer fails (e.g. OOM);
    /// the value graph itself is always encodable.
    pub fn to_msgpack(&self) -> Result<Vec<u8>, rmpv::encode::Error> {
        let value = self.to_value();
        let mut buffer = Vec::new();
        rmpv::encode::write_value(&mut buffer, &value)?;
        Ok(buffer)
    }

    /// Decode from the Redis wire form. **No shape validation** beyond a
    /// successful msgpack decode + the presence of a known `kind` — the decoded
    /// value is otherwise trusted (matching the TS Redis adapter, which decodes
    /// and casts).
    ///
    /// # Errors
    /// Returns an error when the bytes are not valid msgpack, the top level is
    /// not a map, or `kind` is missing/unknown.
    pub fn from_msgpack(bytes: &[u8]) -> Result<Self, EnvelopeDecodeError> {
        let value = rmpv::decode::read_value(&mut &*bytes)
            .map_err(|err| EnvelopeDecodeError::Decode(err.to_string()))?;
        Self::from_value(&value)
    }

    /// Project the envelope into a dynamic [`Value`] map with keys in §1.3
    /// order. `app_id == None` is omitted (back-compat — older peers also omit
    /// it).
    #[must_use]
    #[allow(clippy::too_many_lines)] // a flat, per-variant field projection
    pub fn to_value(&self) -> Value {
        let s = |text: &str| Value::String(text.to_string().into());
        let mut entries: Vec<(Value, Value)> = vec![(s("kind"), s(self.kind()))];
        match self {
            Self::StreamEvent {
                origin_node_id,
                tenant_id,
                app_id,
                stream,
                stream_id,
                sequence,
                packed,
            } => {
                entries.push((s("originNodeId"), s(origin_node_id)));
                entries.push((s("tenantId"), s(tenant_id)));
                push_app_id(&mut entries, app_id.as_ref());
                entries.push((s("stream"), s(stream)));
                entries.push((s("streamId"), s(stream_id)));
                entries.push((s("sequence"), Value::from(*sequence)));
                entries.push((s("packed"), packed_to_value(packed)));
            }
            Self::Objects {
                origin_node_id,
                tenant_id,
                app_id,
                object_type,
                objects,
            } => {
                entries.push((s("originNodeId"), s(origin_node_id)));
                entries.push((s("tenantId"), s(tenant_id)));
                push_app_id(&mut entries, app_id.as_ref());
                entries.push((s("type"), s(object_type)));
                entries.push((s("objects"), Value::Array(objects.clone())));
            }
            Self::ObjectDeletes {
                origin_node_id,
                tenant_id,
                app_id,
                object_type,
                ids,
            } => {
                entries.push((s("originNodeId"), s(origin_node_id)));
                entries.push((s("tenantId"), s(tenant_id)));
                push_app_id(&mut entries, app_id.as_ref());
                entries.push((s("type"), s(object_type)));
                entries.push((s("ids"), Value::Array(ids.iter().map(|id| s(id)).collect())));
            }
            Self::Signal {
                origin_node_id,
                tenant_id,
                app_id,
                name,
                key,
                value,
                request_id,
            } => {
                entries.push((s("originNodeId"), s(origin_node_id)));
                entries.push((s("tenantId"), s(tenant_id)));
                push_app_id(&mut entries, app_id.as_ref());
                entries.push((s("name"), s(name)));
                entries.push((s("key"), s(key)));
                entries.push((s("value"), value.clone()));
                entries.push((s("requestId"), s(request_id)));
            }
            Self::ProjectionDelta {
                origin_node_id,
                tenant_id,
                app_id,
                projection,
                changes,
            } => {
                entries.push((s("originNodeId"), s(origin_node_id)));
                entries.push((s("tenantId"), s(tenant_id)));
                push_app_id(&mut entries, app_id.as_ref());
                entries.push((s("projection"), s(projection)));
                entries.push((s("changes"), changes_to_value(changes)));
            }
            Self::PresenceDelta {
                origin_node_id,
                tenant_id,
                app_id,
                name,
                records,
                cleared,
            } => {
                entries.push((s("originNodeId"), s(origin_node_id)));
                entries.push((s("tenantId"), s(tenant_id)));
                push_app_id(&mut entries, app_id.as_ref());
                entries.push((s("name"), s(name)));
                entries.push((s("records"), changes_to_value(records)));
                entries.push((
                    s("cleared"),
                    Value::Array(cleared.iter().map(|c| s(c)).collect()),
                ));
            }
            Self::MediaPlacementClaim {
                origin_node_id,
                tenant_id,
                call_id,
                home_node_id,
                announced_ip,
            } => {
                entries.push((s("originNodeId"), s(origin_node_id)));
                entries.push((s("tenantId"), s(tenant_id)));
                entries.push((s("callId"), s(call_id)));
                entries.push((s("homeNodeId"), s(home_node_id)));
                entries.push((s("announcedIp"), s(announced_ip)));
            }
            Self::MediaPlacementRelease {
                origin_node_id,
                tenant_id,
                call_id,
            } => {
                entries.push((s("originNodeId"), s(origin_node_id)));
                entries.push((s("tenantId"), s(tenant_id)));
                entries.push((s("callId"), s(call_id)));
            }
        }
        Value::Map(entries)
    }

    /// Reconstruct an envelope from a dynamic [`Value`] map (the inverse of
    /// [`Self::to_value`]). Unknown extra keys are ignored; absent `appId`
    /// decodes to `None`.
    ///
    /// # Errors
    /// Returns an error when the value is not a map or `kind` is
    /// missing/unknown.
    pub fn from_value(value: &Value) -> Result<Self, EnvelopeDecodeError> {
        let map = value.as_map().ok_or(EnvelopeDecodeError::NotAMap)?;
        let get = |name: &str| {
            map.iter()
                .find(|(k, _)| k.as_str() == Some(name))
                .map(|(_, v)| v)
        };
        let str_field = |name: &str| {
            get(name)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        let opt_str = |name: &str| get(name).and_then(Value::as_str).map(ToString::to_string);
        let kind = get("kind")
            .and_then(Value::as_str)
            .ok_or(EnvelopeDecodeError::MissingKind)?;
        let origin = || str_field("originNodeId");
        let tenant = || str_field("tenantId");
        let app_id = || opt_str("appId");
        Ok(match kind {
            "streamEvent" => Self::StreamEvent {
                origin_node_id: origin(),
                tenant_id: tenant(),
                app_id: app_id(),
                stream: str_field("stream"),
                stream_id: str_field("streamId"),
                sequence: get("sequence").and_then(Value::as_i64).unwrap_or_default(),
                packed: get("packed").map(value_to_packed).unwrap_or_default(),
            },
            "objects" => Self::Objects {
                origin_node_id: origin(),
                tenant_id: tenant(),
                app_id: app_id(),
                object_type: str_field("type"),
                objects: get("objects")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            },
            "objectDeletes" => Self::ObjectDeletes {
                origin_node_id: origin(),
                tenant_id: tenant(),
                app_id: app_id(),
                object_type: str_field("type"),
                ids: get("ids").map(value_to_strings).unwrap_or_default(),
            },
            "signal" => Self::Signal {
                origin_node_id: origin(),
                tenant_id: tenant(),
                app_id: app_id(),
                name: str_field("name"),
                key: str_field("key"),
                value: get("value").cloned().unwrap_or(Value::Nil),
                request_id: str_field("requestId"),
            },
            "projectionDelta" => Self::ProjectionDelta {
                origin_node_id: origin(),
                tenant_id: tenant(),
                app_id: app_id(),
                projection: str_field("projection"),
                changes: get("changes").map(value_to_changes).unwrap_or_default(),
            },
            "presenceDelta" => Self::PresenceDelta {
                origin_node_id: origin(),
                tenant_id: tenant(),
                app_id: app_id(),
                name: str_field("name"),
                records: get("records").map(value_to_changes).unwrap_or_default(),
                cleared: get("cleared").map(value_to_strings).unwrap_or_default(),
            },
            "mediaPlacementClaim" => Self::MediaPlacementClaim {
                origin_node_id: origin(),
                tenant_id: tenant(),
                call_id: str_field("callId"),
                home_node_id: str_field("homeNodeId"),
                announced_ip: str_field("announcedIp"),
            },
            "mediaPlacementRelease" => Self::MediaPlacementRelease {
                origin_node_id: origin(),
                tenant_id: tenant(),
                call_id: str_field("callId"),
            },
            other => return Err(EnvelopeDecodeError::UnknownKind(other.to_string())),
        })
    }
}

/// Push an `appId` entry only when present (absent ⇒ omitted, back-compat).
fn push_app_id(entries: &mut Vec<(Value, Value)>, app_id: Option<&String>) {
    if let Some(app_id) = app_id {
        entries.push((
            Value::String("appId".to_string().into()),
            Value::String(app_id.clone().into()),
        ));
    }
}

/// `[streamTypeId, streamKey, sequence, eventId, eventTypeId, fields]` as a
/// nested msgpack array. `fields` is `[[fieldId, value], ...]`.
fn packed_to_value(packed: &PackedStreamEvent) -> Value {
    let (stream_type_id, stream_key, sequence, event_id, event_type_id, fields) = packed;
    Value::Array(vec![
        Value::from(*stream_type_id),
        Value::String(stream_key.clone().into()),
        Value::from(*sequence),
        Value::String(event_id.clone().into()),
        Value::from(*event_type_id),
        Value::Array(
            fields
                .iter()
                .map(|(field_id, value)| Value::Array(vec![Value::from(*field_id), value.clone()]))
                .collect(),
        ),
    ])
}

/// Inverse of [`packed_to_value`]. Missing/short arrays decode to defaults
/// (matching the TS adapter's "trust the decode" posture).
fn value_to_packed(value: &Value) -> PackedStreamEvent {
    let items = value.as_array().map(Vec::as_slice).unwrap_or_default();
    let i64_at = |i: usize| items.get(i).and_then(Value::as_i64).unwrap_or_default();
    let str_at = |i: usize| {
        items
            .get(i)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let fields = items
        .get(5)
        .and_then(Value::as_array)
        .map(|fields| {
            fields
                .iter()
                .filter_map(|field| {
                    let pair = field.as_array()?;
                    Some((
                        pair.first().and_then(Value::as_i64).unwrap_or_default(),
                        pair.get(1).cloned().unwrap_or(Value::Nil),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    (
        i64_at(0),
        str_at(1),
        i64_at(2),
        str_at(3),
        i64_at(4),
        fields,
    )
}

/// `[{ key, value }, ...]` as a msgpack array of two-key maps (insertion order
/// `key`, `value`). A `Value::Nil` value encodes as msgpack `nil` (the wire
/// `null` removal marker).
fn changes_to_value(changes: &[ProjectionChange]) -> Value {
    Value::Array(
        changes
            .iter()
            .map(|change| {
                Value::Map(vec![
                    (
                        Value::String("key".to_string().into()),
                        Value::String(change.key.clone().into()),
                    ),
                    (
                        Value::String("value".to_string().into()),
                        change.value.clone(),
                    ),
                ])
            })
            .collect(),
    )
}

/// Inverse of [`changes_to_value`].
fn value_to_changes(value: &Value) -> Vec<ProjectionChange> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let map = item.as_map()?;
                    let find = |name: &str| {
                        map.iter()
                            .find(|(k, _)| k.as_str() == Some(name))
                            .map(|(_, v)| v)
                    };
                    Some(ProjectionChange {
                        key: find("key")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        value: find("value").cloned().unwrap_or(Value::Nil),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Decode a msgpack array of strings (`ids` / `cleared`).
fn value_to_strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(ToString::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Failure decoding a [`ClusterEnvelope`] from msgpack/[`Value`].
#[derive(Debug, thiserror::Error)]
pub enum EnvelopeDecodeError {
    /// The bytes were not valid msgpack.
    #[error("cluster envelope msgpack decode failed: {0}")]
    Decode(String),
    /// The top-level value was not a map.
    #[error("cluster envelope is not a map")]
    NotAMap,
    /// No `kind` discriminator was present.
    #[error("cluster envelope is missing the kind field")]
    MissingKind,
    /// The `kind` discriminator was not one of the eight known variants.
    #[error("cluster envelope has unknown kind: {0}")]
    UnknownKind(String),
}

// ---- serde (JSON / debug bridge) -------------------------------------------
//
// The dynamic-Value path above is the load-bearing msgpack wire form. These
// serde impls route through it so JSON and any serde-driven serialization
// produce the same internally-tagged map keyed by `kind`. Built on
// `serde_json::Value` for the round-trip via the dynamic representation.

impl Serialize for ClusterEnvelope {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // rmpv::Value implements Serialize and emits the natural JSON/CBOR shape
        // (maps as maps, arrays as arrays), which matches the TS object exactly.
        self.to_value().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ClusterEnvelope {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Self::from_value(&value).map_err(serde::de::Error::custom)
    }
}

/// Generate a fresh random node id (`randomNodeId`, `bus.ts:243-247`).
///
/// The TS version concatenates two base36 `Math.random()` slices (~64 bits,
/// ~16 chars). We draw the same entropy from the thread RNG. Any unique string
/// is acceptable; only media placement compares ids, and only for ordering.
#[must_use]
pub fn random_node_id() -> NodeId {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let chunk = |rng: &mut rand::rngs::ThreadRng| -> String {
        let n: u64 = rng.r#gen();
        // base36, padded/truncated to 8 chars like the TS slice(2, 10).
        let mut s = to_base36(n);
        while s.len() < 8 {
            s.insert(0, '0');
        }
        s.truncate(8);
        s
    };
    format!("{}{}", chunk(&mut rng), chunk(&mut rng))
}

/// Base36 digit set (lowercase), matching JS `Number#toString(36)`.
const BASE36_DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";

/// Lowercase base36 of `n` (digits 0-9a-z), matching JS `Number#toString(36)`.
fn to_base36(mut n: u64) -> String {
    if n == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(BASE36_DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}
