//! The FROZEN `FrickPushPayload` wire contract (map 06 §3.10) and the canonical
//! APNs / FCM body encoders the adapters share (§3.7 `encodeApnsBody`, §3.8
//! `encodeFcmMessage`).
//!
//! This contract is decoded byte-for-byte by the native SDKs
//! (`packages/swift/Sources/FrickSwift/Push/FrickPushPayload.swift`,
//! `apps/android/.../FrickPushReceiver.kt`) and is pinned end-to-end by
//! `apps/server/tests/push-wire-contract.test.ts`. The SDK decoders read by KEY
//! PATH, not by byte order, so this port matches the exact key paths + value
//! types (string-valued FCM `data`, the hoisted APNs top-level data) rather than
//! the TS object insertion order — JSON object key order is not load-bearing for
//! the decoders, and `serde_json`'s map sorts keys.
//!
//! - APNs (Swift `from(userInfo:)`): reads `aps.alert.title|body`,
//!   `aps.thread-id`, top-level `intent` and `deepLink`; `data` = every
//!   top-level key except `aps`/`intent`/`deepLink`.
//! - FCM (Kotlin `from(notification, data)`): `notification.title|body`; the
//!   `data` map must be all-string; reserved keys `intent`/`threadId`/`deepLink`
//!   read out of `data`; remaining entries are custom data.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json};

use super::types::FrickNotificationIntent;

/// The decoded client-side payload shape (Swift `FrickPushPayload`,
/// `FrickPushPayload.swift:21-45`). `intent` is REQUIRED — a payload without a
/// top-level `intent` is rejected by the decoders (`nil`). `data` is always a
/// `[String: String]` on the wire.
///
/// This struct exists so the contract is documented in one place and so tests
/// can round-trip the encoded forms back to the shape the SDKs see. The server
/// never decodes its own pushes; it only encodes (via [`encode_apns_body`] /
/// [`encode_fcm_message`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FrickPushPayload {
    /// Required semantic id.
    pub intent: String,
    /// Alert title, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Alert body, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// Grouping id, if any.
    #[serde(rename = "threadId", default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    /// Deep link, if any.
    #[serde(rename = "deepLink", default, skip_serializing_if = "Option::is_none")]
    pub deep_link: Option<String>,
    /// Custom data — all-string on the wire (FCM v1 requirement; APNs hoists).
    #[serde(default)]
    pub data: std::collections::BTreeMap<String, String>,
}

/// `encodeApnsBody` (apns-adapter.ts:248-268), the FROZEN APNs JSON (§3.7):
///
/// ```jsonc
/// {
///   "aps": {
///     "alert": { "title": ..., "body": ... },  // only when title or body present
///     "thread-id": "<threadId>",                // only when threadId set
///     "sound": "default"                         // ALWAYS
///   },
///   // every intent.body.data entry hoisted to TOP LEVEL (key "aps" skipped)
///   "deepLink": "<deepLink>",                    // only when set
///   "intent": "<intent>"                         // ALWAYS present
/// }
/// ```
///
/// Hoisted `data` values keep their JSON type (APNs/Swift stringifies NSNumber
/// at decode, drops other types) — matching the TS, which assigns `value`
/// verbatim. The `aps` key is skipped if present in `data`.
#[must_use]
pub fn encode_apns_body(intent: &FrickNotificationIntent) -> Json {
    let entries = data_entries(intent);
    let client_rendered = is_client_rendered(&entries);
    let mut aps = Map::new();
    if intent.body.title.is_some() || intent.body.body.is_some() {
        let mut alert = Map::new();
        if let Some(title) = &intent.body.title {
            alert.insert("title".to_string(), Json::String(title.clone()));
        }
        if let Some(body) = &intent.body.body {
            alert.insert("body".to_string(), Json::String(body.clone()));
        }
        aps.insert("alert".to_string(), Json::Object(alert));
    }
    if let Some(thread_id) = &intent.thread_id {
        aps.insert("thread-id".to_string(), Json::String(thread_id.clone()));
    }
    if client_rendered {
        // An opt-in client-rendered alert lets an iOS Notification Service
        // Extension attach communication intent context, while the paired
        // background wake gives the app a chance to sync encrypted state.
        aps.insert("mutable-content".to_string(), Json::from(1));
        aps.insert("content-available".to_string(), Json::from(1));
    }
    aps.insert("sound".to_string(), Json::String("default".to_string()));

    let mut payload = Map::new();
    payload.insert("aps".to_string(), Json::Object(aps));
    // Hoist every data entry to the top level (skip "aps").
    for (key, value) in entries {
        if key == "aps" {
            continue;
        }
        payload.insert(key, value);
    }
    if let Some(deep_link) = &intent.deep_link {
        payload.insert("deepLink".to_string(), Json::String(deep_link.clone()));
    }
    payload.insert("intent".to_string(), Json::String(intent.intent.clone()));
    Json::Object(payload)
}

/// `encodeFcmMessage` (fcm-adapter.ts:150-172), the FROZEN FCM v1 `message`
/// (§3.8):
///
/// ```jsonc
/// {
///   "token": "<registration.token>",
///   "notification": { "title": ..., "body": ... },  // only when title or body present
///   "data": {                                         // ALWAYS present; ALL VALUES STRINGS
///     "intent": "<intent>",                           // first
///     "threadId": "...",                              // when set
///     "deepLink": "...",                              // when set
///     // each intent.body.data entry: strings verbatim, non-strings JSON.stringify'd
///   }
/// }
/// ```
///
/// `data` values are ALWAYS strings: a string passes through verbatim; any other
/// JSON value is `JSON.stringify`'d (matching the TS `typeof v === "string" ? v
/// : JSON.stringify(v)`). Custom-data keys can shadow the reserved
/// `intent`/`threadId`/`deepLink` keys (spread after them).
#[must_use]
pub fn encode_fcm_message(intent: &FrickNotificationIntent, token: &str) -> Json {
    let entries = data_entries(intent);
    let client_rendered = is_client_rendered(&entries);
    let mut message = Map::new();
    message.insert("token".to_string(), Json::String(token.to_string()));
    if !client_rendered && (intent.body.title.is_some() || intent.body.body.is_some()) {
        let mut notification = Map::new();
        if let Some(title) = &intent.body.title {
            notification.insert("title".to_string(), Json::String(title.clone()));
        }
        if let Some(body) = &intent.body.body {
            notification.insert("body".to_string(), Json::String(body.clone()));
        }
        message.insert("notification".to_string(), Json::Object(notification));
    }

    let mut data = Map::new();
    data.insert("intent".to_string(), Json::String(intent.intent.clone()));
    if let Some(thread_id) = &intent.thread_id {
        data.insert("threadId".to_string(), Json::String(thread_id.clone()));
    }
    if let Some(deep_link) = &intent.deep_link {
        data.insert("deepLink".to_string(), Json::String(deep_link.clone()));
    }
    for (key, value) in entries {
        data.insert(key, Json::String(stringify_fcm_value(&value)));
    }
    message.insert("data".to_string(), Json::Object(data));
    if client_rendered {
        // Notification+data messages are rendered by Play services while an
        // Android app is backgrounded and bypass its decrypting receiver.
        message.insert(
            "android".to_string(),
            serde_json::json!({ "priority": "HIGH" }),
        );
    }
    Json::Object(message)
}

fn is_client_rendered(entries: &[(String, Json)]) -> bool {
    entries.iter().any(|(key, value)| {
        key == "clientRendered" && (value == &Json::Bool(true) || value.as_str() == Some("true"))
    })
}

/// Decode the `intent.body.data` map into `(key, json_value)` pairs. The intent
/// body holds a self-describing msgpack [`Value`](frick_protocol::Value); a
/// non-map / absent `data` yields no entries.
fn data_entries(intent: &FrickNotificationIntent) -> Vec<(String, Json)> {
    let Some(data) = &intent.body.data else {
        return Vec::new();
    };
    let frick_protocol::Value::Map(entries) = data else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|(k, v)| {
            let key = k.as_str()?.to_string();
            Some((key, msgpack_to_json(v)))
        })
        .collect()
}

/// `JSON.stringify(v)` for a non-string FCM data value, or the string verbatim
/// (`typeof v === "string" ? v : JSON.stringify(v)`).
fn stringify_fcm_value(value: &Json) -> String {
    match value {
        Json::String(s) => s.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// Convert a dynamic msgpack [`Value`](frick_protocol::Value) to a
/// [`serde_json::Value`]. rmpv's `Serialize` impl is self-describing, so this is
/// a faithful round-trip for the value shapes intents carry.
fn msgpack_to_json(value: &frick_protocol::Value) -> Json {
    serde_json::to_value(value).unwrap_or(Json::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::push::types::NotificationBody;
    use frick_protocol::Value;

    fn intent_with(
        body: NotificationBody,
        thread: Option<&str>,
        deep: Option<&str>,
    ) -> FrickNotificationIntent {
        FrickNotificationIntent {
            intent: "message.new".to_string(),
            tenant_id: "tenant-1".to_string(),
            recipient_user_ids: vec!["user-1".to_string()],
            body,
            thread_id: thread.map(str::to_string),
            deep_link: deep.map(str::to_string),
        }
    }

    #[test]
    fn apns_body_full_shape_matches_contract() {
        let body = NotificationBody {
            title: Some("Hi".to_string()),
            body: Some("there".to_string()),
            data: Some(Value::Map(vec![
                (Value::from("convoId"), Value::from("c-9")),
                (Value::from("count"), Value::from(3i64)),
                // "aps" in data is dropped.
                (Value::from("aps"), Value::from("nope")),
            ])),
        };
        let json = encode_apns_body(&intent_with(body, Some("t-1"), Some("frick://x")));
        // aps.alert.title/body, aps.thread-id, aps.sound always "default".
        assert_eq!(json["aps"]["alert"]["title"], Json::from("Hi"));
        assert_eq!(json["aps"]["alert"]["body"], Json::from("there"));
        assert_eq!(json["aps"]["thread-id"], Json::from("t-1"));
        assert_eq!(json["aps"]["sound"], Json::from("default"));
        // Hoisted data, top-level deepLink + intent.
        assert_eq!(json["convoId"], Json::from("c-9"));
        assert_eq!(json["count"], Json::from(3));
        assert_eq!(json["deepLink"], Json::from("frick://x"));
        assert_eq!(json["intent"], Json::from("message.new"));
        // The "aps" data key never overwrote the aps object.
        assert!(json["aps"].is_object());
    }

    #[test]
    fn apns_body_omits_alert_and_optionals_when_absent() {
        let json = encode_apns_body(&intent_with(NotificationBody::default(), None, None));
        // No alert (no title/body), no thread-id, no deepLink — but sound + intent.
        assert!(json["aps"].get("alert").is_none());
        assert!(json["aps"].get("thread-id").is_none());
        assert_eq!(json["aps"]["sound"], Json::from("default"));
        assert!(json.get("deepLink").is_none());
        assert_eq!(json["intent"], Json::from("message.new"));
    }

    #[test]
    fn fcm_message_full_shape_matches_contract() {
        let body = NotificationBody {
            title: Some("Hi".to_string()),
            body: Some("there".to_string()),
            data: Some(Value::Map(vec![
                (Value::from("convoId"), Value::from("c-9")),
                (Value::from("count"), Value::from(3i64)),
            ])),
        };
        let json = encode_fcm_message(
            &intent_with(body, Some("t-1"), Some("frick://x")),
            "device-token",
        );
        assert_eq!(json["token"], Json::from("device-token"));
        assert_eq!(json["notification"]["title"], Json::from("Hi"));
        assert_eq!(json["notification"]["body"], Json::from("there"));
        // data is ALL strings.
        assert_eq!(json["data"]["intent"], Json::from("message.new"));
        assert_eq!(json["data"]["threadId"], Json::from("t-1"));
        assert_eq!(json["data"]["deepLink"], Json::from("frick://x"));
        assert_eq!(json["data"]["convoId"], Json::from("c-9"));
        // Non-string hoisted as JSON.stringify => "3".
        assert_eq!(json["data"]["count"], Json::from("3"));
    }

    #[test]
    fn fcm_message_data_always_present_notification_omitted_when_empty() {
        let json = encode_fcm_message(&intent_with(NotificationBody::default(), None, None), "tok");
        assert!(json.get("notification").is_none());
        // data always present with at least the intent.
        assert_eq!(json["data"]["intent"], Json::from("message.new"));
        assert!(json["data"].get("threadId").is_none());
    }

    #[test]
    fn client_rendered_push_is_mutable_on_apns_and_data_only_on_fcm() {
        let body = NotificationBody {
            title: Some("Aura".to_string()),
            body: Some("New message".to_string()),
            data: Some(Value::Map(vec![
                (Value::from("conversationId"), Value::from("c-9")),
                (Value::from("clientRendered"), Value::from(true)),
            ])),
        };
        let intent = intent_with(body, Some("c-9"), None);

        let apns = encode_apns_body(&intent);
        assert_eq!(apns["aps"]["alert"]["body"], Json::from("New message"));
        assert_eq!(apns["aps"]["mutable-content"], Json::from(1));
        assert_eq!(apns["aps"]["content-available"], Json::from(1));

        let fcm = encode_fcm_message(&intent, "tok");
        assert!(fcm.get("notification").is_none());
        assert_eq!(fcm["android"]["priority"], Json::from("HIGH"));
        assert_eq!(fcm["data"]["clientRendered"], Json::from("true"));
    }

    #[test]
    fn decoded_payload_round_trips_intent_required() {
        let payload = FrickPushPayload {
            intent: "message.new".to_string(),
            title: Some("Hi".to_string()),
            body: None,
            thread_id: Some("t-1".to_string()),
            deep_link: None,
            data: [("convoId".to_string(), "c-9".to_string())]
                .into_iter()
                .collect(),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["intent"], Json::from("message.new"));
        assert_eq!(json["title"], Json::from("Hi"));
        assert!(json.get("body").is_none());
        assert_eq!(json["threadId"], Json::from("t-1"));
        let back: FrickPushPayload = serde_json::from_value(json).unwrap();
        assert_eq!(back, payload);
    }
}
