//! FR-79 / FR-283 (calls phase C) — the call control-plane state machine.
//!
//! Ports the core of the deleted `apps/server/src/calls/call-control-plane.ts`.
//! Frick owns call **state + signaling**; this state machine drives the
//! lifecycle
//!
//! ```text
//!   create → (per invitee) ringing → accept/join → leave → end
//! ```
//!
//! persisting `CallRoom` / `CallInvite` / `CallParticipant` as ordinary objects
//! (no new tables), appending durable lifecycle events to the `CallEventStream`,
//! and brokering the [`MediaPlaneAdapter`]: it allocates a media session at
//! create time, issues a per-participant join token at join time, and releases
//! the session at end time. It never touches media bytes.
//!
//! Invariants enforced:
//!  - Only the creator may invite (invites are fixed at create time) and end.
//!  - Only an invitee may join, and only while the call is live.
//!  - You cannot join / accept / leave / set-media on an ended call.
//!  - A participant may only change *their own* media state and leave.
//!  - The media plane's participant cap is enforced before allocating a grant.
//!
//! The SFU-specific media negotiation ops (connect-transport / produce / consume)
//! are deferred to FR-287/288; on the fake/P2P media plane there is no SFU
//! companion, so they surface [`CallError::MediaUnsupported`].

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use frick_protocol::Value;
use frick_protocol::calls::{
    CallInviteRecord, CallInviteState, CallKind, CallMediaGrant, CallMediaStatePatch,
    CallParticipantRecord, CallParticipantState, CallRoomRecord, CallRoomState,
};
use frick_protocol::value::to_value;
use frick_store::FrickStore;

use super::media_plane::{
    AllocateSessionOptions, IssueJoinTokenOptions, MediaParticipant, MediaPlaneAdapter,
};
use super::schema::{
    CALL_CREATED, CALL_ENDED, CALL_EVENT_STREAM, CALL_INVITE_ACCEPTED, CALL_INVITE_SENT,
    CALL_INVITE_TYPE, CALL_PARTICIPANT_JOINED, CALL_PARTICIPANT_LEFT,
    CALL_PARTICIPANT_MEDIA_CHANGED, CALL_PARTICIPANT_TYPE, CALL_ROOM_TYPE,
};
use crate::principal::{DEFAULT_APP_ID, DEFAULT_TENANT_ID};

/// Why a call-lifecycle transition was rejected (maps to the TS
/// `CallStateErrorReason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallStateReason {
    NoInvitees,
    CapacityExceeded,
    CallNotFound,
    CallEnded,
    NotParticipant,
    InviteAlreadyResolved,
}

/// Why a call action was forbidden (maps to the TS `CallAuthzErrorReason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallAuthzReason {
    NotCreator,
    NotInvitee,
    NotSelf,
}

/// A control-plane failure. The gateway maps these onto a `Nack`.
#[derive(Debug, thiserror::Error)]
pub enum CallError {
    #[error("{1}")]
    State(CallStateReason, String),
    #[error("{1}")]
    Authz(CallAuthzReason, String),
    #[error("{0}")]
    MediaUnsupported(String),
    #[error("media plane error: {0}")]
    Media(#[from] super::media_plane::MediaPlaneError),
    #[error("store error: {0}")]
    Store(String),
    #[error("decode error: {0}")]
    Decode(String),
}

impl CallError {
    fn state(reason: CallStateReason, message: impl Into<String>) -> Self {
        Self::State(reason, message.into())
    }
    fn authz(reason: CallAuthzReason, message: impl Into<String>) -> Self {
        Self::Authz(reason, message.into())
    }
}

type CallResult<T> = Result<T, CallError>;

/// The actor a call command runs as — derived from the connection's
/// authenticated principal by the gateway.
#[derive(Debug, Clone)]
pub struct CallActor {
    pub tenant_id: String,
    pub user_id: String,
    pub device_id: String,
    pub app_id: Option<String>,
}

impl CallActor {
    fn app_id(&self) -> &str {
        self.app_id.as_deref().unwrap_or(DEFAULT_APP_ID)
    }
}

/// Input to [`CallControlPlane::create_call`].
#[derive(Debug, Clone)]
pub struct CreateCallInput {
    pub conversation_id: String,
    /// Users invited to the call. Must be non-empty and exclude the creator.
    pub invitee_user_ids: Vec<String>,
    pub kind: Option<CallKind>,
    pub region_hint: Option<String>,
}

/// Result of [`CallControlPlane::create_call`].
#[derive(Debug, Clone)]
pub struct CreateCallResult {
    pub room: CallRoomRecord,
    pub invites: Vec<CallInviteRecord>,
}

/// Result of [`CallControlPlane::join_call`].
#[derive(Debug, Clone)]
pub struct JoinCallResult {
    pub room: CallRoomRecord,
    pub participant: CallParticipantRecord,
    pub media_grant: CallMediaGrant,
}

/// A wall-clock + id source, injectable for deterministic tests (the
/// determinism seam — the control plane is a time/random boundary above the
/// stores).
pub trait CallClock: Send + Sync {
    /// Epoch milliseconds.
    fn now_ms(&self) -> i64;
    /// A fresh, unique call id.
    fn new_call_id(&self) -> String;
}

/// Production [`CallClock`]: the system wall clock + a UUID call-id source.
pub struct SystemCallClock;

impl CallClock for SystemCallClock {
    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .and_then(|d| i64::try_from(d.as_millis()).ok())
            .unwrap_or(0)
    }
    fn new_call_id(&self) -> String {
        format!("call-{}", uuid::Uuid::new_v4().simple())
    }
}

/// The call control plane (FR-79 / FR-283).
pub struct CallControlPlane {
    store: Arc<FrickStore>,
    media: Arc<dyn MediaPlaneAdapter>,
    clock: Arc<dyn CallClock>,
    /// Monotonic counter making per-call stream request-ids unique + ordered.
    seq: AtomicU64,
}

impl CallControlPlane {
    #[must_use]
    pub fn new(
        store: Arc<FrickStore>,
        media: Arc<dyn MediaPlaneAdapter>,
        clock: Arc<dyn CallClock>,
    ) -> Self {
        Self {
            store,
            media,
            clock,
            seq: AtomicU64::new(0),
        }
    }

    fn now_iso(&self) -> String {
        crate::boot::iso_from_epoch_ms(self.clock.now_ms())
    }

    // -- create --------------------------------------------------------------

    /// Create a call: persist the `CallRoom` (state `ringing`), one `CallInvite`
    /// per invitee, allocate a media session, and emit `CallCreated` +
    /// `CallInviteSent` events.
    // invitee / invite / invitees are the domain terms; keep them.
    #[allow(clippy::similar_names)]
    pub async fn create_call(
        &self,
        actor: &CallActor,
        input: CreateCallInput,
    ) -> CallResult<CreateCallResult> {
        let invitees = dedupe(&input.invitee_user_ids, &actor.user_id);
        if invitees.is_empty() {
            return Err(CallError::state(
                CallStateReason::NoInvitees,
                "A call must invite at least one user other than the creator",
            ));
        }

        // Enforce the media plane's participant cap up front: a P2P plane
        // advertises max_participants:2, so creator + invitees must fit.
        if let Some(max) = self.media.describe().max_participants
            && invitees.len() + 1 > max as usize
        {
            return Err(CallError::state(
                CallStateReason::CapacityExceeded,
                format!("Call exceeds the media plane capacity of {max} participants"),
            ));
        }

        let app_id = actor.app_id().to_string();
        let call_id = self.clock.new_call_id();
        let created_at = self.now_iso();
        let kind = input.kind.unwrap_or(CallKind::Video);

        // Allocate the media room up front so the room id is durable on the
        // CallRoom and a joining client can be issued a token immediately.
        let session = self
            .media
            .allocate_session(
                &call_id,
                AllocateSessionOptions {
                    region_hint: input.region_hint.clone(),
                    expected_participants: u32::try_from(invitees.len() + 1).ok(),
                },
            )
            .await?;

        let room = CallRoomRecord {
            id: call_id.clone(),
            conversation_id: input.conversation_id.clone(),
            state: CallRoomState::Ringing,
            created_by: actor.user_id.clone(),
            kind,
            created_at: created_at.clone(),
            started_at: None,
            ended_at: None,
            media_session_id: Some(session.media_session_id.clone()),
            transport: Some(session.transport.as_wire().to_string()),
        };
        self.write_room(actor, &app_id, &room).await?;
        self.append_event(
            actor,
            &app_id,
            &call_id,
            CALL_CREATED,
            &[
                ("callId", call_id.clone().into()),
                ("conversationId", input.conversation_id.clone().into()),
                ("createdBy", actor.user_id.clone().into()),
                ("kind", kind_wire(kind).into()),
                ("createdAt", created_at.clone().into()),
            ],
        )
        .await?;

        let mut invites = Vec::with_capacity(invitees.len());
        for invitee in invitees {
            let invite = CallInviteRecord {
                id: format!("{call_id}:{invitee}"),
                call_id: call_id.clone(),
                invitee_user_id: invitee.clone(),
                status: CallInviteState::Ringing,
                invited_by: actor.user_id.clone(),
                invited_at: created_at.clone(),
                responded_at: None,
            };
            self.write_invite(actor, &app_id, &invite).await?;
            self.append_event(
                actor,
                &app_id,
                &call_id,
                CALL_INVITE_SENT,
                &[
                    ("callId", call_id.clone().into()),
                    ("inviteeUserId", invitee.clone().into()),
                    ("invitedBy", actor.user_id.clone().into()),
                ],
            )
            .await?;
            invites.push(invite);
        }

        Ok(CreateCallResult { room, invites })
    }

    // -- accept / decline ----------------------------------------------------

    /// Mark an invitee's `CallInvite` as accepted and emit `CallInviteAccepted`.
    /// Re-accepting an already-accepted invite is allowed (the client may have
    /// lost the ack); accepting a declined/cancelled invite or one for an ended
    /// call is rejected. The creator is an implicit member (synthetic invite).
    pub async fn accept_invite(
        &self,
        actor: &CallActor,
        call_id: &str,
    ) -> CallResult<CallInviteRecord> {
        let app_id = actor.app_id().to_string();
        let room = self.require_live_room(actor, &app_id, call_id).await?;
        let Some(invite) = self
            .require_invitee_or_creator(&room, actor, &app_id)
            .await?
        else {
            return Ok(self.creator_self_invite(call_id, &actor.user_id));
        };
        match invite.status {
            CallInviteState::Declined | CallInviteState::Cancelled => Err(CallError::state(
                CallStateReason::InviteAlreadyResolved,
                format!(
                    "Invite for {} is resolved and cannot be accepted",
                    actor.user_id
                ),
            )),
            CallInviteState::Accepted => Ok(invite),
            CallInviteState::Ringing => {
                let updated = CallInviteRecord {
                    status: CallInviteState::Accepted,
                    responded_at: Some(self.now_iso()),
                    ..invite
                };
                self.write_invite(actor, &app_id, &updated).await?;
                self.append_event(
                    actor,
                    &app_id,
                    call_id,
                    CALL_INVITE_ACCEPTED,
                    &[
                        ("callId", call_id.into()),
                        ("inviteeUserId", actor.user_id.clone().into()),
                    ],
                )
                .await?;
                Ok(updated)
            }
        }
    }

    /// Decline an invite: mark it `declined` (no event; the creator sees it via
    /// the invite row). Rejects a non-invitee or an ended call.
    pub async fn decline_invite(
        &self,
        actor: &CallActor,
        call_id: &str,
    ) -> CallResult<CallInviteRecord> {
        let app_id = actor.app_id().to_string();
        let room = self.require_live_room(actor, &app_id, call_id).await?;
        let Some(invite) = self
            .require_invitee_or_creator(&room, actor, &app_id)
            .await?
        else {
            // The creator cannot decline their own call.
            return Err(CallError::authz(
                CallAuthzReason::NotInvitee,
                "The call creator has no invite to decline",
            ));
        };
        if matches!(invite.status, CallInviteState::Accepted) {
            return Err(CallError::state(
                CallStateReason::InviteAlreadyResolved,
                "An accepted invite cannot be declined",
            ));
        }
        let updated = CallInviteRecord {
            status: CallInviteState::Declined,
            responded_at: Some(self.now_iso()),
            ..invite
        };
        self.write_invite(actor, &app_id, &updated).await?;
        Ok(updated)
    }

    // -- join ----------------------------------------------------------------

    /// Join a call: only an invitee (or the creator) may join, and only while
    /// the call is live. Persists the `CallParticipant` (`joined`), activates the
    /// room on first join, emits `CallParticipantJoined`, implicitly accepts a
    /// still-ringing invite, and issues a per-participant media join token.
    #[allow(clippy::too_many_lines)]
    pub async fn join_call(&self, actor: &CallActor, call_id: &str) -> CallResult<JoinCallResult> {
        let app_id = actor.app_id().to_string();
        let room = self.require_live_room(actor, &app_id, call_id).await?;
        let invite = self
            .require_invitee_or_creator(&room, actor, &app_id)
            .await?;
        if let Some(invite) = &invite
            && matches!(
                invite.status,
                CallInviteState::Declined | CallInviteState::Cancelled
            )
        {
            return Err(CallError::state(
                CallStateReason::InviteAlreadyResolved,
                format!("Invite for {} is resolved; cannot join", actor.user_id),
            ));
        }

        let joined_at = self.now_iso();
        self.assert_participant_capacity(actor, &app_id, call_id)
            .await?;

        // Only an invitee's still-ringing invite is implicitly accepted.
        if let Some(invite) = invite
            && !matches!(invite.status, CallInviteState::Accepted)
        {
            let accepted = CallInviteRecord {
                status: CallInviteState::Accepted,
                responded_at: Some(joined_at.clone()),
                ..invite
            };
            self.write_invite(actor, &app_id, &accepted).await?;
            self.append_event(
                actor,
                &app_id,
                call_id,
                CALL_INVITE_ACCEPTED,
                &[
                    ("callId", call_id.into()),
                    ("inviteeUserId", actor.user_id.clone().into()),
                ],
            )
            .await?;
        }

        let participant = CallParticipantRecord {
            id: format!("{call_id}:{}:{}", actor.user_id, actor.device_id),
            call_id: call_id.to_string(),
            user_id: actor.user_id.clone(),
            device_id: actor.device_id.clone(),
            state: CallParticipantState::Joined,
            joined_at: joined_at.clone(),
            left_at: None,
            mic_enabled: true,
            camera_enabled: false,
            screen_sharing: false,
            speaking: None,
            network_quality: None,
        };
        self.write_participant(actor, &app_id, &participant).await?;

        // First join activates the room.
        let active_room = if matches!(room.state, CallRoomState::Ringing) {
            let activated = CallRoomRecord {
                state: CallRoomState::Active,
                started_at: Some(joined_at.clone()),
                ..room
            };
            self.write_room(actor, &app_id, &activated).await?;
            activated
        } else {
            room
        };

        self.append_event(
            actor,
            &app_id,
            call_id,
            CALL_PARTICIPANT_JOINED,
            &[
                ("callId", call_id.into()),
                ("userId", actor.user_id.clone().into()),
                ("deviceId", actor.device_id.clone().into()),
                ("joinedAt", joined_at.clone().into()),
            ],
        )
        .await?;

        let grant = self
            .media
            .issue_join_token(
                call_id,
                MediaParticipant {
                    user_id: actor.user_id.clone(),
                    device_id: actor.device_id.clone(),
                },
                self.clock.now_ms(),
                IssueJoinTokenOptions::default(),
            )
            .await?;

        Ok(JoinCallResult {
            room: active_room,
            participant,
            media_grant: CallMediaGrant {
                call_id: grant.call_id,
                media_session_id: grant.media_session_id,
                user_id: grant.user_id,
                device_id: grant.device_id,
                token: grant.token,
                expires_at: grant.expires_at,
                connection: grant.connection,
            },
        })
    }

    // -- media state ---------------------------------------------------------

    /// Update a participant's media state. A participant may only change *their
    /// own* state. Emits `CallParticipantMediaChanged`.
    pub async fn set_media_state(
        &self,
        actor: &CallActor,
        call_id: &str,
        patch: &CallMediaStatePatch,
    ) -> CallResult<CallParticipantRecord> {
        let app_id = actor.app_id().to_string();
        self.require_live_room(actor, &app_id, call_id).await?;
        let participant = self
            .read_participant(actor, &app_id, call_id, &actor.user_id, &actor.device_id)
            .await?;
        let participant = match participant {
            Some(p) if matches!(p.state, CallParticipantState::Joined) => p,
            _ => {
                return Err(CallError::state(
                    CallStateReason::NotParticipant,
                    format!(
                        "{}/{} is not an active participant of {call_id}",
                        actor.user_id, actor.device_id
                    ),
                ));
            }
        };
        let updated = CallParticipantRecord {
            mic_enabled: patch.mic_enabled.unwrap_or(participant.mic_enabled),
            camera_enabled: patch.camera_enabled.unwrap_or(participant.camera_enabled),
            screen_sharing: patch.screen_sharing.unwrap_or(participant.screen_sharing),
            ..participant
        };
        self.write_participant(actor, &app_id, &updated).await?;
        self.append_event(
            actor,
            &app_id,
            call_id,
            CALL_PARTICIPANT_MEDIA_CHANGED,
            &[
                ("callId", call_id.into()),
                ("userId", actor.user_id.clone().into()),
                ("deviceId", actor.device_id.clone().into()),
                ("micEnabled", updated.mic_enabled.into()),
                ("cameraEnabled", updated.camera_enabled.into()),
                ("screenSharing", updated.screen_sharing.into()),
            ],
        )
        .await?;
        Ok(updated)
    }

    // -- leave / end ---------------------------------------------------------

    /// Leave a call. Marks the actor's `CallParticipant` `left` and emits
    /// `CallParticipantLeft`. When the last active participant leaves an `active`
    /// call, the call auto-ends. Leaving an ended call is idempotent.
    pub async fn leave_call(&self, actor: &CallActor, call_id: &str) -> CallResult<CallRoomRecord> {
        let app_id = actor.app_id().to_string();
        let Some(room) = self.read_room(actor, &app_id, call_id).await? else {
            return Err(CallError::state(
                CallStateReason::CallNotFound,
                format!("Call {call_id} does not exist"),
            ));
        };
        if matches!(room.state, CallRoomState::Ended) {
            return Ok(room);
        }
        let participant = self
            .read_participant(actor, &app_id, call_id, &actor.user_id, &actor.device_id)
            .await?;
        let participant = match participant {
            Some(p) if matches!(p.state, CallParticipantState::Joined) => p,
            _ => {
                return Err(CallError::state(
                    CallStateReason::NotParticipant,
                    format!(
                        "{}/{} is not an active participant of {call_id}",
                        actor.user_id, actor.device_id
                    ),
                ));
            }
        };
        let left_at = self.now_iso();
        let left = CallParticipantRecord {
            state: CallParticipantState::Left,
            left_at: Some(left_at.clone()),
            ..participant
        };
        self.write_participant(actor, &app_id, &left).await?;
        self.append_event(
            actor,
            &app_id,
            call_id,
            CALL_PARTICIPANT_LEFT,
            &[
                ("callId", call_id.into()),
                ("userId", actor.user_id.clone().into()),
                ("deviceId", actor.device_id.clone().into()),
                ("leftAt", left_at.into()),
            ],
        )
        .await?;

        // Auto-end when the last active participant leaves an active call.
        let remaining = self
            .active_participant_count(actor, &app_id, call_id)
            .await?;
        if remaining == 0 && matches!(room.state, CallRoomState::Active) {
            return self
                .finalize_end(actor, &app_id, call_id, &actor.user_id)
                .await;
        }
        Ok(room)
    }

    /// End a call. Only the creator may end it explicitly. Marks the `CallRoom`
    /// `ended`, releases the media session, emits `CallEnded`. Idempotent.
    pub async fn end_call(&self, actor: &CallActor, call_id: &str) -> CallResult<CallRoomRecord> {
        let app_id = actor.app_id().to_string();
        let Some(room) = self.read_room(actor, &app_id, call_id).await? else {
            return Err(CallError::state(
                CallStateReason::CallNotFound,
                format!("Call {call_id} does not exist"),
            ));
        };
        if room.created_by != actor.user_id {
            return Err(CallError::authz(
                CallAuthzReason::NotCreator,
                "Only the call creator may end the call",
            ));
        }
        if matches!(room.state, CallRoomState::Ended) {
            return Ok(room);
        }
        self.finalize_end(actor, &app_id, call_id, &actor.user_id)
            .await
    }

    // -- reads (for clients / reconnect / the signal gate) -------------------

    /// Read a call room (tenant + app scoped).
    pub async fn get_room(
        &self,
        actor: &CallActor,
        call_id: &str,
    ) -> CallResult<Option<CallRoomRecord>> {
        let app_id = actor.app_id().to_string();
        self.read_room(actor, &app_id, call_id).await
    }

    /// All participant rows for a call.
    pub async fn list_participants(
        &self,
        actor: &CallActor,
        call_id: &str,
    ) -> CallResult<Vec<CallParticipantRecord>> {
        let app_id = actor.app_id().to_string();
        let rows = self
            .store
            .objects()
            .list(&actor.tenant_id, CALL_PARTICIPANT_TYPE, &app_id)
            .await
            .map_err(|e| CallError::Store(e.to_string()))?;
        Ok(rows
            .into_iter()
            .filter_map(|row| decode::<CallParticipantRecord>(row).ok())
            .filter(|p| p.call_id == call_id)
            .collect())
    }

    /// Whether `user_id` may participate in `call_id`'s signaling: true iff they
    /// are the creator, a participant, or a non-resolved invitee of a non-ended
    /// call. Backs the FR-284 WebRTCSignal relay gate.
    pub async fn is_signal_member(
        &self,
        tenant_id: &str,
        app_id: &str,
        call_id: &str,
        user_id: &str,
    ) -> bool {
        let actor = CallActor {
            tenant_id: tenant_id.to_string(),
            user_id: user_id.to_string(),
            device_id: String::new(),
            app_id: Some(app_id.to_string()),
        };
        let Ok(Some(room)) = self.read_room(&actor, app_id, call_id).await else {
            return false;
        };
        if matches!(room.state, CallRoomState::Ended) {
            return false;
        }
        if room.created_by == user_id {
            return true;
        }
        if let Ok(Some(invite)) = self.read_invite(&actor, app_id, call_id, user_id).await
            && !matches!(
                invite.status,
                CallInviteState::Declined | CallInviteState::Cancelled
            )
        {
            return true;
        }
        self.list_participants(&actor, call_id)
            .await
            .is_ok_and(|ps| ps.iter().any(|p| p.user_id == user_id))
    }

    // -- internals -----------------------------------------------------------

    async fn finalize_end(
        &self,
        actor: &CallActor,
        app_id: &str,
        call_id: &str,
        ended_by: &str,
    ) -> CallResult<CallRoomRecord> {
        let ended_at = self.now_iso();
        // Re-read to guard against a delete/end race (fail closed, never persist
        // a corrupt room spread from a missing read).
        let Some(room) = self.read_room(actor, app_id, call_id).await? else {
            return Err(CallError::state(
                CallStateReason::CallNotFound,
                format!("Call {call_id} does not exist"),
            ));
        };
        if matches!(room.state, CallRoomState::Ended) {
            return Ok(room);
        }
        let ended = CallRoomRecord {
            state: CallRoomState::Ended,
            ended_at: Some(ended_at.clone()),
            ..room
        };
        self.write_room(actor, app_id, &ended).await?;
        self.append_event(
            actor,
            app_id,
            call_id,
            CALL_ENDED,
            &[
                ("callId", call_id.into()),
                ("endedBy", ended_by.into()),
                ("endedAt", ended_at.into()),
            ],
        )
        .await?;
        self.media.release_session(call_id).await;
        Ok(ended)
    }

    async fn require_live_room(
        &self,
        actor: &CallActor,
        app_id: &str,
        call_id: &str,
    ) -> CallResult<CallRoomRecord> {
        let Some(room) = self.read_room(actor, app_id, call_id).await? else {
            return Err(CallError::state(
                CallStateReason::CallNotFound,
                format!("Call {call_id} does not exist"),
            ));
        };
        if matches!(room.state, CallRoomState::Ended) {
            return Err(CallError::state(
                CallStateReason::CallEnded,
                format!("Call {call_id} has already ended"),
            ));
        }
        Ok(room)
    }

    /// Resolve the actor's invite, or `None` when the actor is the creator (an
    /// implicit, always-accepted member of their own call). `NotInvitee` for
    /// anyone who is neither.
    async fn require_invitee_or_creator(
        &self,
        room: &CallRoomRecord,
        actor: &CallActor,
        app_id: &str,
    ) -> CallResult<Option<CallInviteRecord>> {
        if room.created_by == actor.user_id {
            return Ok(None);
        }
        match self
            .read_invite(actor, app_id, &room.id, &actor.user_id)
            .await?
        {
            Some(invite) => Ok(Some(invite)),
            None => Err(CallError::authz(
                CallAuthzReason::NotInvitee,
                format!("{} was not invited to call {}", actor.user_id, room.id),
            )),
        }
    }

    async fn active_participant_count(
        &self,
        actor: &CallActor,
        _app_id: &str,
        call_id: &str,
    ) -> CallResult<usize> {
        let participants = self.list_participants(actor, call_id).await?;
        Ok(participants
            .iter()
            .filter(|p| matches!(p.state, CallParticipantState::Joined))
            .count())
    }

    /// Reject a join that would push the call past the media plane's participant
    /// cap. Counts *distinct active users*; an already-joined (user,device) is a
    /// free rejoin so a reconnect never trips the cap.
    async fn assert_participant_capacity(
        &self,
        actor: &CallActor,
        _app_id: &str,
        call_id: &str,
    ) -> CallResult<()> {
        let Some(max) = self.media.describe().max_participants else {
            return Ok(());
        };
        let participants = self.list_participants(actor, call_id).await?;
        let is_rejoin = participants.iter().any(|p| {
            matches!(p.state, CallParticipantState::Joined)
                && p.user_id == actor.user_id
                && p.device_id == actor.device_id
        });
        let mut active_users: std::collections::HashSet<&str> = participants
            .iter()
            .filter(|p| matches!(p.state, CallParticipantState::Joined))
            .map(|p| p.user_id.as_str())
            .collect();
        if is_rejoin || active_users.contains(actor.user_id.as_str()) {
            return Ok(());
        }
        active_users.insert(actor.user_id.as_str());
        if active_users.len() > max as usize {
            return Err(CallError::state(
                CallStateReason::CapacityExceeded,
                format!("Call {call_id} is full (media plane capacity is {max})"),
            ));
        }
        Ok(())
    }

    fn creator_self_invite(&self, call_id: &str, user_id: &str) -> CallInviteRecord {
        let at = self.now_iso();
        CallInviteRecord {
            id: format!("{call_id}:{user_id}"),
            call_id: call_id.to_string(),
            invitee_user_id: user_id.to_string(),
            status: CallInviteState::Accepted,
            invited_by: user_id.to_string(),
            invited_at: at.clone(),
            responded_at: Some(at),
        }
    }

    // -- store helpers -------------------------------------------------------

    async fn read_room(
        &self,
        actor: &CallActor,
        app_id: &str,
        call_id: &str,
    ) -> CallResult<Option<CallRoomRecord>> {
        self.read_object(actor, app_id, CALL_ROOM_TYPE, call_id)
            .await
    }

    async fn read_invite(
        &self,
        actor: &CallActor,
        app_id: &str,
        call_id: &str,
        user_id: &str,
    ) -> CallResult<Option<CallInviteRecord>> {
        self.read_object(
            actor,
            app_id,
            CALL_INVITE_TYPE,
            &format!("{call_id}:{user_id}"),
        )
        .await
    }

    async fn read_participant(
        &self,
        actor: &CallActor,
        app_id: &str,
        call_id: &str,
        user_id: &str,
        device_id: &str,
    ) -> CallResult<Option<CallParticipantRecord>> {
        self.read_object(
            actor,
            app_id,
            CALL_PARTICIPANT_TYPE,
            &format!("{call_id}:{user_id}:{device_id}"),
        )
        .await
    }

    async fn read_object<T: serde::de::DeserializeOwned>(
        &self,
        actor: &CallActor,
        app_id: &str,
        object_type: &str,
        object_id: &str,
    ) -> CallResult<Option<T>> {
        let row = self
            .store
            .objects()
            .read(&actor.tenant_id, object_type, object_id, app_id)
            .await
            .map_err(|e| CallError::Store(e.to_string()))?;
        match row {
            Some(value) => Ok(Some(decode::<T>(value)?)),
            None => Ok(None),
        }
    }

    async fn write_room(
        &self,
        actor: &CallActor,
        app_id: &str,
        room: &CallRoomRecord,
    ) -> CallResult<()> {
        self.write_object(actor, app_id, CALL_ROOM_TYPE, &room.id, room)
            .await
    }

    async fn write_invite(
        &self,
        actor: &CallActor,
        app_id: &str,
        invite: &CallInviteRecord,
    ) -> CallResult<()> {
        self.write_object(actor, app_id, CALL_INVITE_TYPE, &invite.id, invite)
            .await
    }

    async fn write_participant(
        &self,
        actor: &CallActor,
        app_id: &str,
        participant: &CallParticipantRecord,
    ) -> CallResult<()> {
        self.write_object(
            actor,
            app_id,
            CALL_PARTICIPANT_TYPE,
            &participant.id,
            participant,
        )
        .await
    }

    async fn write_object<T: serde::Serialize>(
        &self,
        actor: &CallActor,
        app_id: &str,
        object_type: &str,
        object_id: &str,
        record: &T,
    ) -> CallResult<()> {
        let value = to_value(record).map_err(|e| CallError::Decode(e.to_string()))?;
        self.store
            .upsert_object_with_policy(
                &actor.tenant_id,
                app_id,
                object_type,
                object_id,
                &value,
                None,
            )
            .await
            .map_err(|e| CallError::Store(e.to_string()))?;
        Ok(())
    }

    async fn append_event(
        &self,
        actor: &CallActor,
        app_id: &str,
        call_id: &str,
        event: &str,
        fields: &[(&str, Value)],
    ) -> CallResult<()> {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let request_id = format!("call-{call_id}-{event}-{seq}");
        let payload = Value::Map(
            fields
                .iter()
                .map(|(k, v)| (Value::from(*k), v.clone()))
                .collect(),
        );
        self.store
            .append_event(
                &actor.tenant_id,
                CALL_EVENT_STREAM,
                call_id,
                "call-control-plane",
                &request_id,
                event,
                &payload,
                app_id,
            )
            .await
            .map_err(|e| CallError::Store(e.to_string()))?;
        Ok(())
    }
}

fn kind_wire(kind: CallKind) -> &'static str {
    match kind {
        CallKind::Audio => "audio",
        CallKind::Video => "video",
    }
}

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> CallResult<T> {
    rmpv::ext::from_value(value).map_err(|e| CallError::Decode(e.to_string()))
}

/// De-duplicate the invitee list and drop the creator.
fn dedupe(values: &[String], exclude: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    values
        .iter()
        .filter(|u| u.as_str() != exclude)
        .filter(|u| seen.insert((*u).clone()))
        .cloned()
        .collect()
}

/// Build a [`CallActor`] for the default tenant — a test/convenience helper.
#[must_use]
pub fn call_actor(user_id: &str, device_id: &str) -> CallActor {
    CallActor {
        tenant_id: DEFAULT_TENANT_ID.to_string(),
        user_id: user_id.to_string(),
        device_id: device_id.to_string(),
        app_id: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calls::FakeMediaPlaneAdapter;
    use crate::calls::schema::build_call_schema;
    use frick_store::{FrickStore, FrickStoreOptions};

    struct TestClock {
        counter: AtomicU64,
    }
    impl TestClock {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                counter: AtomicU64::new(0),
            })
        }
    }
    impl CallClock for TestClock {
        fn now_ms(&self) -> i64 {
            1_700_000_000_000
        }
        fn new_call_id(&self) -> String {
            format!("call-{}", self.counter.fetch_add(1, Ordering::Relaxed) + 1)
        }
    }

    async fn plane(media: Arc<dyn MediaPlaneAdapter>) -> CallControlPlane {
        let store = Arc::new(
            FrickStore::open(FrickStoreOptions {
                schema: Some(build_call_schema()),
                ..FrickStoreOptions::default()
            })
            .await
            .expect("open store"),
        );
        CallControlPlane::new(store, media, TestClock::new())
    }

    fn create_input(invitees: &[&str]) -> CreateCallInput {
        CreateCallInput {
            conversation_id: "conv-1".into(),
            invitee_user_ids: invitees.iter().map(|u| (*u).to_string()).collect(),
            kind: None,
            region_hint: None,
        }
    }

    #[tokio::test]
    async fn create_then_join_then_end_full_lifecycle() {
        let cp = plane(Arc::new(FakeMediaPlaneAdapter::sfu())).await;
        let ada = call_actor("ada", "dev-a");
        let grace = call_actor("grace", "dev-g");

        // Create: room is ringing, has a media session, and one invite for grace.
        let created = cp
            .create_call(&ada, create_input(&["grace"]))
            .await
            .unwrap();
        assert_eq!(created.room.state, CallRoomState::Ringing);
        assert!(created.room.media_session_id.is_some());
        assert_eq!(created.invites.len(), 1);
        assert_eq!(created.invites[0].invitee_user_id, "grace");
        let call_id = created.room.id.clone();

        // Grace joins: room activates, she gets a participant + a media grant,
        // and her invite is implicitly accepted.
        let joined = cp.join_call(&grace, &call_id).await.unwrap();
        assert_eq!(joined.room.state, CallRoomState::Active);
        assert_eq!(joined.participant.state, CallParticipantState::Joined);
        assert!(joined.media_grant.token.contains("grace"));
        let invites = {
            let invite = cp
                .read_invite(&grace, DEFAULT_APP_ID, &call_id, "grace")
                .await
                .unwrap()
                .unwrap();
            invite.status
        };
        assert_eq!(invites, CallInviteState::Accepted);

        // Creator ends: room is ended, media session released.
        let ended = cp.end_call(&ada, &call_id).await.unwrap();
        assert_eq!(ended.state, CallRoomState::Ended);
        // Joining an ended call is rejected.
        let err = cp.join_call(&grace, &call_id).await.unwrap_err();
        assert!(matches!(
            err,
            CallError::State(CallStateReason::CallEnded, _)
        ));
    }

    #[tokio::test]
    async fn create_requires_a_non_creator_invitee() {
        let cp = plane(Arc::new(FakeMediaPlaneAdapter::sfu())).await;
        let ada = call_actor("ada", "dev-a");
        // Inviting only yourself → noInvitees.
        let err = cp
            .create_call(&ada, create_input(&["ada"]))
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            CallError::State(CallStateReason::NoInvitees, _)
        ));
    }

    #[tokio::test]
    async fn only_an_invitee_or_creator_may_join() {
        let cp = plane(Arc::new(FakeMediaPlaneAdapter::sfu())).await;
        let ada = call_actor("ada", "dev-a");
        let mallory = call_actor("mallory", "dev-m");
        let created = cp
            .create_call(&ada, create_input(&["grace"]))
            .await
            .unwrap();
        let err = cp.join_call(&mallory, &created.room.id).await.unwrap_err();
        assert!(matches!(
            err,
            CallError::Authz(CallAuthzReason::NotInvitee, _)
        ));
    }

    #[tokio::test]
    async fn only_the_creator_may_end() {
        let cp = plane(Arc::new(FakeMediaPlaneAdapter::sfu())).await;
        let ada = call_actor("ada", "dev-a");
        let grace = call_actor("grace", "dev-g");
        let created = cp
            .create_call(&ada, create_input(&["grace"]))
            .await
            .unwrap();
        cp.join_call(&grace, &created.room.id).await.unwrap();
        let err = cp.end_call(&grace, &created.room.id).await.unwrap_err();
        assert!(matches!(
            err,
            CallError::Authz(CallAuthzReason::NotCreator, _)
        ));
    }

    #[tokio::test]
    async fn last_participant_leaving_auto_ends_the_call() {
        let cp = plane(Arc::new(FakeMediaPlaneAdapter::sfu())).await;
        let ada = call_actor("ada", "dev-a");
        let grace = call_actor("grace", "dev-g");
        let created = cp
            .create_call(&ada, create_input(&["grace"]))
            .await
            .unwrap();
        cp.join_call(&grace, &created.room.id).await.unwrap();
        let room = cp.leave_call(&grace, &created.room.id).await.unwrap();
        assert_eq!(room.state, CallRoomState::Ended, "auto-end on last leave");
    }

    #[tokio::test]
    async fn p2p_capacity_cap_is_enforced() {
        // P2P advertises max_participants:2 → creator + 1 invitee is the limit;
        // a 2-invitee call is rejected at create time.
        let cp = plane(Arc::new(FakeMediaPlaneAdapter::p2p())).await;
        let ada = call_actor("ada", "dev-a");
        let err = cp
            .create_call(&ada, create_input(&["grace", "heidi"]))
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            CallError::State(CallStateReason::CapacityExceeded, _)
        ));
    }

    #[tokio::test]
    async fn set_media_state_only_affects_own_participant() {
        let cp = plane(Arc::new(FakeMediaPlaneAdapter::sfu())).await;
        let ada = call_actor("ada", "dev-a");
        let grace = call_actor("grace", "dev-g");
        let created = cp
            .create_call(&ada, create_input(&["grace"]))
            .await
            .unwrap();
        cp.join_call(&grace, &created.room.id).await.unwrap();
        let patch = CallMediaStatePatch {
            mic_enabled: Some(false),
            camera_enabled: Some(true),
            screen_sharing: None,
        };
        let updated = cp
            .set_media_state(&grace, &created.room.id, &patch)
            .await
            .unwrap();
        assert!(!updated.mic_enabled);
        assert!(updated.camera_enabled);
        // ada never joined → not an active participant → rejected.
        let err = cp
            .set_media_state(&ada, &created.room.id, &patch)
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            CallError::State(CallStateReason::NotParticipant, _)
        ));
    }

    #[tokio::test]
    async fn is_signal_member_gates_creator_invitee_and_outsider() {
        let cp = plane(Arc::new(FakeMediaPlaneAdapter::sfu())).await;
        let ada = call_actor("ada", "dev-a");
        let created = cp
            .create_call(&ada, create_input(&["grace"]))
            .await
            .unwrap();
        let call_id = &created.room.id;
        assert!(
            cp.is_signal_member(DEFAULT_TENANT_ID, DEFAULT_APP_ID, call_id, "ada")
                .await,
            "creator is a member"
        );
        assert!(
            cp.is_signal_member(DEFAULT_TENANT_ID, DEFAULT_APP_ID, call_id, "grace")
                .await,
            "invitee is a member"
        );
        assert!(
            !cp.is_signal_member(DEFAULT_TENANT_ID, DEFAULT_APP_ID, call_id, "mallory")
                .await,
            "an outsider is not a member"
        );
    }
}
