//! Black-box conformance scenarios for the realtime-calls control plane
//! (FR-290).
//!
//! These reuse the same harness client as `tests/scenarios.rs` (HTTP + WS +
//! Hello) and boot the default in-process Rust server via
//! [`ServerHandle::in_process`]. The assertions are about *observable* wire
//! behavior: the `CallCommand` → `CallCommandResult` RPC over the WebSocket,
//! the call lifecycle (create → join), and the FR-284 membership gate on the
//! `WebRTCSignal` relay.
//!
//! # Schema
//!
//! The store packs every object/event write against the active schema's field
//! list (`pack_object_record`), so a `CallCommand` only works if the running
//! server's schema carries the call control-plane types with the **current**
//! field shape. The committed product-test fixture
//! (`conformance/fixtures/wire/schema-product-validated.bin`) carries exactly
//! those canonical call types — its `CallRoom`/`CallInvite`/`CallParticipant`,
//! `CallEventStream`, and `WebRTCSignal` mirror
//! `frick_server::calls::schema::{call_object_defs, call_stream_defs,
//! call_event_defs, call_signal_defs}` field-for-field (FR-294). So the default
//! product schema is call-ready: no strip-and-splice is needed, and these
//! scenarios run against the same fixture every other conformance scenario does.

use frick_conformance::{ServerHandle, nonce};
use frick_protocol::FrickFrame;
use frick_protocol::Value;
use frick_protocol::calls::{CallCommandName, CallCommandOp, CallKind, CallRoomState};

/// Pull the `reason` string out of a `Nack`'s error details map.
fn nack_reason(nack: &frick_protocol::frame::NackPayload) -> Option<&str> {
    match nack.error.details.as_ref()? {
        Value::Map(entries) => entries.iter().find_map(|(key, value)| {
            if key.as_str() == Some("reason") {
                value.as_str()
            } else {
                None
            }
        }),
        _ => None,
    }
}

/// Await the next `CallCommandResult` frame, panicking on anything else
/// (a `Nack` is surfaced with its reason so a failing scenario is legible).
async fn expect_call_result(
    ws: &mut frick_conformance::WsConn,
) -> frick_protocol::calls::CallCommandResultPayload {
    match ws.next_frame().await {
        FrickFrame::CallCommandResult(result) => *result,
        FrickFrame::Nack(nack) => panic!(
            "expected CallCommandResult, got Nack code={:?} reason={:?}: {}",
            nack.error.code,
            nack_reason(&nack),
            nack.error.message
        ),
        other => panic!("expected CallCommandResult, got {other:?}"),
    }
}

/// A representative `WebRTCSignal` value: the control plane only routes it (the
/// payload is opaque bytes), so a minimal but well-shaped map is enough.
fn webrtc_offer_value(sender_device_id: &str) -> Value {
    Value::Map(vec![
        ("senderDeviceId".into(), sender_device_id.into()),
        ("kind".into(), "offer".into()),
        // The schema's `payload` is bytes; route an opaque blob byte-for-byte.
        ("payload".into(), Value::Binary(b"sdp-offer".to_vec())),
    ])
}

// ---- create -----------------------------------------------------------------

/// FR-282: a creator's `Op::Create` (one conversation + one invitee) replies
/// with a `CallCommandResult` carrying `op == create`, a `ringing` room, and
/// the invite for the invitee.
#[tokio::test]
async fn call_create_replies_with_ringing_room_and_invite() {
    let server = ServerHandle::in_process().await;
    let http = server.http();

    let suffix = nonce();
    let creator = format!("user-call-creator-{suffix}");
    let invitee = format!("user-call-invitee-{suffix}");
    let conversation_id = format!("conversation-{suffix}");
    let token = http.dev_login_token(&creator).await;

    let mut ws = server.connect_ws().await;
    ws.hello(&token).await;

    let request_id = format!("req-create-{suffix}");
    ws.call_command(
        &request_id,
        CallCommandOp::Create {
            conversation_id: conversation_id.clone(),
            invitee_user_ids: vec![invitee.clone()],
            kind: Some(CallKind::Video),
            region_hint: None,
        },
    )
    .await;

    let result = expect_call_result(&mut ws).await;
    assert_eq!(
        result.request_id, request_id,
        "result echoes the request id"
    );
    assert_eq!(result.op, CallCommandName::Create);

    let room = result.room.expect("create result carries a room");
    assert_eq!(room.conversation_id, conversation_id);
    assert_eq!(room.state, CallRoomState::Ringing);
    assert_eq!(room.created_by, creator);

    let sent_invites = result.invites.expect("create result carries invites");
    assert_eq!(sent_invites.len(), 1, "one invitee → one invite");
    assert_eq!(sent_invites[0].invitee_user_id, invitee);
    assert_eq!(sent_invites[0].call_id, room.id);

    ws.close().await;
    server.shutdown().await;
}

// ---- join -------------------------------------------------------------------

/// FR-282: the invitee, on a *second* authenticated connection, `Op::Join`s the
/// call and the reply carries a `participant` (state `joined`) + a `media_grant`
/// from the (fake SFU) media plane. The room flips to `active` on first join.
#[tokio::test]
async fn invitee_join_yields_participant_and_media_grant() {
    let server = ServerHandle::in_process().await;
    let http = server.http();

    let suffix = nonce();
    let creator = format!("user-call-creator-{suffix}");
    let invitee = format!("user-call-invitee-{suffix}");
    let conversation_id = format!("conversation-{suffix}");

    let creator_token = http.dev_login_token(&creator).await;
    let invitee_token = http.dev_login_token(&invitee).await;

    // Creator connection creates the call.
    let mut creator_ws = server.connect_ws().await;
    creator_ws.hello(&creator_token).await;
    creator_ws
        .call_command(
            &format!("req-create-{suffix}"),
            CallCommandOp::Create {
                conversation_id: conversation_id.clone(),
                invitee_user_ids: vec![invitee.clone()],
                kind: Some(CallKind::Video),
                region_hint: None,
            },
        )
        .await;
    let created = expect_call_result(&mut creator_ws).await;
    let call_id = created.room.expect("create carries a room").id;

    // Invitee connection (a distinct principal via its own dev-login) joins.
    let mut invitee_ws = server.connect_ws().await;
    invitee_ws.hello(&invitee_token).await;
    let join_request_id = format!("req-join-{suffix}");
    invitee_ws
        .call_command(
            &join_request_id,
            CallCommandOp::Join {
                call_id: call_id.clone(),
            },
        )
        .await;

    let result = expect_call_result(&mut invitee_ws).await;
    assert_eq!(result.request_id, join_request_id);
    assert_eq!(result.op, CallCommandName::Join);

    let participant = result.participant.expect("join carries a participant");
    assert_eq!(participant.call_id, call_id);
    assert_eq!(participant.user_id, invitee);
    assert_eq!(
        participant.state,
        frick_protocol::calls::CallParticipantState::Joined
    );

    let grant = result.media_grant.expect("join carries a media grant");
    assert_eq!(grant.call_id, call_id);
    assert_eq!(grant.user_id, invitee);
    assert!(!grant.token.is_empty(), "media grant carries a join token");

    // First join activates the room.
    let room = result.room.expect("join carries the room");
    assert_eq!(room.state, CallRoomState::Active);

    creator_ws.close().await;
    invitee_ws.close().await;
    server.shutdown().await;
}

// ---- signal membership gate (FR-284) ----------------------------------------

/// FR-284: the `WebRTCSignal` relay is gated on call membership. A non-member's
/// `SignalSend` (keyed by the call id) is Nacked `auth.forbidden` reason
/// `notMember`; a member's (the creator's) signal is accepted (`Ack`).
#[tokio::test]
async fn webrtc_signal_is_gated_on_call_membership() {
    let server = ServerHandle::in_process().await;
    let http = server.http();

    let suffix = nonce();
    let creator = format!("user-call-creator-{suffix}");
    let invitee = format!("user-call-invitee-{suffix}");
    let outsider = format!("user-call-outsider-{suffix}");
    let conversation_id = format!("conversation-{suffix}");

    let creator_token = http.dev_login_token(&creator).await;
    let outsider_token = http.dev_login_token(&outsider).await;

    // Creator creates the call (the creator is a member; the outsider is not).
    let mut creator_ws = server.connect_ws().await;
    creator_ws.hello(&creator_token).await;
    creator_ws
        .call_command(
            &format!("req-create-{suffix}"),
            CallCommandOp::Create {
                conversation_id,
                invitee_user_ids: vec![invitee.clone()],
                kind: Some(CallKind::Video),
                region_hint: None,
            },
        )
        .await;
    let created = expect_call_result(&mut creator_ws).await;
    let call_id = created.room.expect("create carries a room").id;

    // A non-member's WebRTCSignal (keyed by the call id) → Nack notMember.
    let mut outsider_ws = server.connect_ws().await;
    outsider_ws.hello(&outsider_token).await;
    let outsider_request_id = format!("req-signal-outsider-{suffix}");
    outsider_ws
        .signal_send(
            &outsider_request_id,
            frick_protocol::calls::WEBRTC_SIGNAL_TYPE,
            &call_id,
            webrtc_offer_value("device-outsider"),
        )
        .await;
    let nack = match outsider_ws.next_frame().await {
        FrickFrame::Nack(nack) => nack,
        other => panic!("expected a Nack for the outsider's signal, got {other:?}"),
    };
    assert_eq!(
        nack.error.code,
        frick_protocol::FrickErrorCode::AuthForbidden,
        "outsider signal nack: {nack:?}"
    );
    assert_eq!(
        nack_reason(&nack),
        Some("notMember"),
        "outsider signal nack: {nack:?}"
    );
    assert_eq!(
        nack.error.request_id, outsider_request_id,
        "nack echoes the request id"
    );

    // The creator IS a member: the same relay is accepted with an Ack.
    let creator_request_id = format!("req-signal-creator-{suffix}");
    creator_ws
        .signal_send(
            &creator_request_id,
            frick_protocol::calls::WEBRTC_SIGNAL_TYPE,
            &call_id,
            webrtc_offer_value("device-creator"),
        )
        .await;
    let ack = match creator_ws.next_frame().await {
        FrickFrame::Ack(ack) => ack,
        other => panic!("expected an Ack for the creator's signal, got {other:?}"),
    };
    assert_eq!(ack.request_id, creator_request_id);

    creator_ws.close().await;
    outsider_ws.close().await;
    server.shutdown().await;
}
