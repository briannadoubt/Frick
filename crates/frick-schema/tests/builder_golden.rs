//! Builder golden test: the DSL must reconstruct `productTestSchema`
//! (`packages/protocol/src/fixtures/product-test-schema.ts`) exactly as the
//! TS encoder shipped it in the wire fixture
//! `conformance/fixtures/wire/schema-product-validated.bin`, and rebuild the
//! foundation schema byte-for-field identical to
//! [`frick_protocol::foundation_schema`].

use frick_protocol::schema::FrickObjectMergePolicy;
use frick_protocol::{FrickFrame, FrickSchema, decode_frame, foundation_schema};
use frick_schema::SchemaBuilder;
use frick_schema::builder::field;
use std::path::PathBuf;

fn wire_fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/fixtures/wire")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|err| {
        panic!(
            "read {} (run `pnpm fixtures:wire` first): {err}",
            path.display()
        )
    })
}

/// `productTestSchema`, transliterated entry-for-entry from the TS fixture.
/// Ids, ordering, required flags, refs, enum values, indexes, merge
/// policies, and TTLs all match the literal — the assertions below pin that
/// against the wire bytes.
fn product_test_schema() -> FrickSchema {
    let builder = SchemaBuilder::new("frick-product-test", "frick-product-test")
        .version("0.1.0")
        .revision(1)
        .minimum_client_revision(1)
        .minimum_server_revision(1)
        // Free-form by design: the hash version differs from schemaVersion
        // in the TS fixture, proving nothing recomputes it.
        .hash("frick-product-test-0.2.0");
    let builder = product_objects(builder);
    let builder = product_streams_and_events(builder);
    let builder = product_ephemera(builder);
    product_views(builder)
        .build()
        .expect("product test schema validates")
}

fn product_objects(builder: SchemaBuilder) -> SchemaBuilder {
    builder
        .object("User", 1, |o| {
            o.field(field::string("displayName", 1).required())
                .field(field::ref_("avatarBlobId", 2, "AttachmentBlob"))
                .index("all", 1, ["displayName"])
        })
        .object("Conversation", 2, |o| {
            o.field(field::enum_("kind", 1, ["dm", "group", "channel"]).required())
                .field(field::string("title", 2))
                .field(field::ref_("createdBy", 3, "User").required())
                .field(field::string("lastMessageEventId", 4))
                .index("all", 1, ["kind"])
        })
        .object("RoomMember", 3, |o| {
            o.field(field::ref_("conversationId", 1, "Conversation").required())
                .field(field::ref_("userId", 2, "User").required())
                .field(field::enum_("role", 3, ["owner", "member"]).required())
                .index("byConversation", 1, ["conversationId"])
        })
        .object("CallRoom", 4, |o| {
            o.field(field::ref_("conversationId", 1, "Conversation").required())
                .field(field::enum_("state", 2, ["ringing", "active", "ended"]).required())
                .field(field::ref_("createdBy", 3, "User").required())
                .index("byConversation", 1, ["conversationId", "state"])
        })
        .object("UserDevice", 5, |o| {
            o.field(field::ref_("userId", 1, "User").required())
                .field(field::string("label", 2))
                .field(field::enum_("platform", 3, ["web", "ios", "android", "server"]).required())
                .field(field::timestamp("lastSeenAt", 4))
                .index("byUser", 1, ["userId"])
        })
        .object("UserSession", 6, |o| {
            o.field(field::ref_("userId", 1, "User").required())
                .field(field::string("deviceId", 2).required())
                .field(field::string("replicaId", 3).required())
                .field(field::timestamp("expiresAt", 4).required())
                .index("byUser", 1, ["userId"])
        })
        .object("MessageDraft", 7, |o| {
            o.field(field::ref_("userId", 1, "User").required())
                .field(field::ref_("conversationId", 2, "Conversation").required())
                .field(field::string("body", 3).required())
                .field(field::timestamp("updatedAt", 4).required())
                .index("byOwner", 1, ["userId", "conversationId"])
                .merge_policy(FrickObjectMergePolicy::VersionPrecondition)
        })
        .object("ScheduledMessage", 8, |o| {
            o.field(field::ref_("userId", 1, "User").required())
                .field(field::ref_("conversationId", 2, "Conversation").required())
                .field(field::string("body", 3).required())
                .field(field::timestamp("scheduledFor", 4).required())
                .field(field::json("attachmentBlobIds", 5))
                .field(field::enum_("status", 6, ["pending", "delivered", "cancelled"]).required())
                .index("byDueDate", 1, ["status", "scheduledFor"])
                .merge_policy(FrickObjectMergePolicy::VersionPrecondition)
        })
}

fn product_streams_and_events(builder: SchemaBuilder) -> SchemaBuilder {
    builder
        .stream("MessageStream", 1, |s| {
            s.key_field(field::ref_("conversationId", 1, "Conversation").required())
                .events([
                    "MessageSent",
                    "MessageEdited",
                    "MessageRedacted",
                    "ReactionAdded",
                    "ReceiptAdvanced",
                ])
        })
        .stream("CallEventStream", 2, |s| {
            s.key_field(field::ref_("callId", 1, "CallRoom").required())
                .events([
                    "CallCreated",
                    "CallParticipantJoined",
                    "CallParticipantLeft",
                    "CallEnded",
                ])
        })
        .event("MessageSent", 1, |e| {
            e.field(field::id("messageId", 1).required())
                .field(field::ref_("senderId", 2, "User").required())
                .field(field::string("body", 3).required())
                .field(field::timestamp("createdAt", 4).required())
                .field(field::json("attachmentBlobIds", 5))
        })
        .event("MessageEdited", 2, |e| {
            e.field(field::id("messageId", 1).required())
                .field(field::string("body", 2).required())
                .field(field::timestamp("editedAt", 3).required())
        })
        .event("MessageRedacted", 3, |e| {
            e.field(field::id("messageId", 1).required())
                .field(field::timestamp("redactedAt", 2).required())
        })
        .event("ReactionAdded", 4, |e| {
            e.field(field::id("messageId", 1).required())
                .field(field::ref_("userId", 2, "User").required())
                .field(field::string("emoji", 3).required())
        })
        .event("ReceiptAdvanced", 5, |e| {
            e.field(field::ref_("userId", 1, "User").required())
                .field(field::int("sequence", 2).required())
        })
        .event("CallCreated", 6, |e| {
            e.field(field::ref_("callId", 1, "CallRoom").required())
                .field(field::ref_("createdBy", 2, "User").required())
        })
        .event("CallParticipantJoined", 7, |e| {
            e.field(field::ref_("userId", 1, "User").required())
                .field(field::string("deviceId", 2).required())
        })
        .event("CallParticipantLeft", 8, |e| {
            e.field(field::ref_("userId", 1, "User").required())
                .field(field::string("deviceId", 2).required())
        })
        .event("CallEnded", 9, |e| {
            e.field(field::timestamp("endedAt", 1).required())
        })
}

fn product_ephemera(builder: SchemaBuilder) -> SchemaBuilder {
    builder
        .presence("TypingState", 1, 5000, |p| {
            p.key_field(field::ref_("conversationId", 1, "Conversation").required())
                .key_field(field::ref_("userId", 2, "User").required())
                .key_field(field::string("deviceId", 3).required())
                .field(field::bool("isTyping", 1).required())
        })
        .signal("WebRTCSignal", 1, 30000, |s| {
            s.key_field(field::ref_("callId", 1, "CallRoom").required())
                .field(field::string("senderDeviceId", 1).required())
                .field(field::string("recipientDeviceId", 2))
                .field(
                    field::enum_(
                        "kind",
                        3,
                        ["offer", "answer", "ice", "renegotiate", "sfuToken"],
                    )
                    .required(),
                )
                .field(field::bytes("payload", 4).required())
        })
        .blob("AttachmentBlob", 1, |b| {
            b.metadata_field(field::string("contentHash", 1).required())
                .metadata_field(field::int("byteLength", 2).required())
                .metadata_field(field::string("mimeType", 3).required())
        })
}

fn product_views(builder: SchemaBuilder) -> SchemaBuilder {
    builder
        .job("PushNotificationJob", 1, |j| {
            j.field(field::ref_("recipientUserId", 1, "User").required())
                .field(field::string("kind", 2).required())
                .field(field::json("payload", 3).required())
        })
        .projection("ConversationInbox", 1, "MessageStream", |p| {
            p.field(field::ref_("conversationId", 1, "Conversation").required())
                .field(field::ref_("userId", 2, "User").required())
                .field(field::string("title", 3))
                .field(field::string("kind", 4).required())
                .field(field::int("lastSequence", 5).required())
                .field(field::string("lastMessageBody", 6))
                .field(field::timestamp("lastMessageAt", 7))
                .field(field::ref_("lastMessageSenderId", 8, "User"))
                .field(field::int("readSequence", 9).required())
                .field(field::int("unreadCount", 10).required())
                .field(field::timestamp("updatedAt", 11).required())
                .index("byConversation", 1, ["conversationId"])
                .index("byUser", 2, ["userId"])
        })
}

#[test]
fn builder_reconstructs_the_product_test_wire_fixture() {
    let built = product_test_schema();

    let bytes = wire_fixture("schema-product-validated.bin");
    let frame = decode_frame(&bytes).expect("fixture decodes as a frame");
    let FrickFrame::Schema(decoded) = frame else {
        panic!("expected a Schema frame, got {frame:?}");
    };

    assert_eq!(
        built, *decoded,
        "builder output diverged from the TS-encoded productTestSchema"
    );
}

#[test]
fn builder_reconstructs_the_foundation_schema() {
    let built = SchemaBuilder::new("frick-foundation", "frick-foundation")
        .version("0.1.0")
        .hash("frick-foundation-empty-0.1.0")
        .build()
        .expect("foundation schema validates");

    assert_eq!(
        built,
        foundation_schema(),
        "builder output diverged from frick_protocol::foundation_schema()"
    );
}
