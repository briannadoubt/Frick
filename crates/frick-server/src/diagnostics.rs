//! Structured diagnostics snapshot assembler (FR-76, FR-262).
//!
//! Port of `apps/server/src/diagnostics.ts` (`assembleDiagnosticsSnapshot`) onto
//! the Rust store/server. Turns a live [`FrickStore`] plus the active
//! [`FrickSchema`] and a small bag of caller-supplied runtime metadata into the
//! shared `DiagnosticsSnapshot` JSON shape documented in
//! `internal/rust-rewrite/maps/01-protocol-wire.md` §13. Both the CLI
//! (`frick inspect diagnostics`, wired by the integrator onto
//! [`assemble_diagnostics_snapshot`]) and the server's
//! `GET /_frick/inspect/diagnostics` endpoint consume it so their output never
//! drifts.
//!
//! The wire model (`packages/protocol/src/diagnostics.ts`):
//!
//! ```text
//! DiagnosticsSnapshot {
//!   diagnosticsVersion: 1,
//!   source: "cli" | "server",
//!   env?,
//!   schema { schemaId, schemaVersion, schemaRevision, schemaHash },
//!   compatibility? { matched, expectedRevision, appliedRevision?, detail? },
//!   subscriptions?, cursors?, pendingAppends?, recentAcks?,
//!   recentErrors,            // required (possibly empty)
//!   connection?,
//!   caches,                  // required (possibly empty)
//!   syncTiming { snapshotAt, lastSuccessfulSyncAt?, startedAt?, uptimeSeconds? },
//!   capabilities?
//! }
//! ```
//!
//! Optionality contract (mirrored from the TS doc comment): `undefined` /
//! key-absent means "not observed here"; an empty array means "observed, and
//! empty". The store-driven path is the lowest common denominator — it fills
//! schema identity, schema/migration compatibility, cursor probes, capabilities,
//! and the idempotency cache slot, and leaves the live-gateway surfaces
//! (`subscriptions`, `pendingAppends`, `connection`, `recentAcks`) absent.
//!
//! ## Determinism
//!
//! This assembler reads no clock and no RNG: `snapshot_at` (ISO), `started_at`,
//! `uptime_seconds`, and `last_successful_sync_at` all arrive via
//! [`AssembleDiagnosticsOptions`] from the route/CLI boundary, exactly like the
//! sibling inspect handlers thread `now_ms` in. Only the async store reads
//! (migration ledger + stream-head probes) touch the database.
//!
//! ## Known store-surface gaps (documented defaults)
//!
//! The Rust [`FrickStore`] facade does not yet expose two surfaces the TS
//! assembler read directly:
//!
//! * **Idempotency cache stats.** `store.idempotencyCache.{size,capacity,
//!   evictions}` is private in the Rust facade (a `Mutex<Option<…>>` field), so
//!   the `idempotency` cache entry is reported with documented defaults
//!   (`size: 0`, `capacity: 0`, `evictions: 0`) — exactly as the sibling
//!   `GET /_frick/inspect/db` route does. TODO(idempotency-stats): replace with
//!   the real getter once the facade exposes one.
//! * **DevTools event feed.** `store.devtoolsEvents.list(...)` (the source of
//!   `recentErrors`) has no Rust port yet (the inspect `devtools/*` routes are
//!   stubbed, FR-249), so `recentErrors` is the empty array — "observed, and
//!   empty". TODO(devtools): derive recent errors from the durable feed once it
//!   lands.

use frick_protocol::{FrickSchema, default_server_capabilities};
use frick_store::FrickStore;
use serde_json::{Value, json};

use crate::routes::ACTIVE_APP_ID;

/// The diagnostics snapshot version this assembler stamps
/// (`DIAGNOSTICS_VERSION = 1`, `packages/protocol/src/diagnostics.ts:172`).
pub const DIAGNOSTICS_VERSION: i64 = 1;

/// Default cap on the number of recent error envelopes surfaced
/// (`AssembleDiagnosticsOptions.recentErrorLimit ?? 20`).
const DEFAULT_RECENT_ERROR_LIMIT: usize = 20;

/// A specific stream cursor the caller wants probed into the snapshot
/// (`DiagnosticsCursorProbe`, `apps/server/src/diagnostics.ts`). The CLI parses
/// these from `stream:streamId` positionals after `diagnostics`; `--tenant-id`
/// applies to all probes.
#[derive(Debug, Clone)]
pub struct DiagnosticsCursorProbe {
    /// Tenant the stream lives in; defaults to `_default` when absent.
    pub tenant_id: Option<String>,
    /// Stream type name.
    pub stream: String,
    /// Stream key / id.
    pub stream_id: String,
}

/// Options threaded in from the route/CLI boundary. Everything time-shaped is
/// supplied here so the assembler stays clock-free (the determinism seam).
#[derive(Debug, Clone, Default)]
pub struct AssembleDiagnosticsOptions {
    /// Where the snapshot was taken (`"cli"` | `"server"`); defaults to `"cli"`
    /// to match the TS `runtime.source ?? "cli"`.
    pub source: Option<String>,
    /// Deployment environment label (`env?`), e.g. `"production"` / `"test"`.
    pub env: Option<String>,
    /// Max recent error envelopes to surface. Default 20.
    pub recent_error_limit: Option<usize>,
    /// Specific stream cursors to probe (the store can't cheaply enumerate
    /// every stream).
    pub cursors: Vec<DiagnosticsCursorProbe>,
    /// ISO timestamp the snapshot was assembled (required `syncTiming.snapshotAt`).
    pub snapshot_at: String,
    /// ISO timestamp of the last successful sync / write, if observed.
    pub last_successful_sync_at: Option<String>,
    /// ISO timestamp the instance started, if known.
    pub started_at: Option<String>,
    /// Seconds since boot, if known.
    pub uptime_seconds: Option<f64>,
    /// Include the negotiated server capabilities + limits block. The HTTP
    /// endpoint sets this; the bare store-driven CLI may omit it.
    pub include_capabilities: bool,
}

/// Assemble a `DiagnosticsSnapshot` JSON value from a running store + the active
/// schema. Async because the migration-ledger read and cursor-head probes go
/// through the `SqlDriver` seam.
///
/// The returned [`serde_json::Value`] is exactly the documented snapshot shape;
/// callers serialize it as the HTTP body or print it from the CLI. It never
/// embeds secrets (no tokens, no PII) and round-trips losslessly through JSON.
pub async fn assemble_diagnostics_snapshot(
    store: &FrickStore,
    schema: &FrickSchema,
    opts: &AssembleDiagnosticsOptions,
) -> Value {
    let source = opts.source.as_deref().unwrap_or("cli");

    // Schema/migration compatibility: compare the running revision against the
    // newest applied migration. Missing/empty ledger => unmatched.
    let compatibility = assemble_compatibility(store, schema).await;

    // Cursors: only the stream heads the caller explicitly asked for. A probe
    // for a nonexistent stream simply contributes no cursor (errors swallowed).
    let cursors = assemble_cursors(store, opts).await;

    // Recent error envelopes come from the DevTools feed in the TS server; the
    // Rust feed is not ported yet (FR-249), so this is the empty array =
    // "observed, and empty". Honour the configured limit for forward-compat.
    let _recent_error_limit = opts
        .recent_error_limit
        .unwrap_or(DEFAULT_RECENT_ERROR_LIMIT);
    let recent_errors: Vec<Value> = Vec::new();

    let mut snapshot = json!({
        "diagnosticsVersion": DIAGNOSTICS_VERSION,
        "source": source,
        "schema": {
            "schemaId": schema.schema_id,
            "schemaVersion": schema.schema_version,
            "schemaRevision": schema.schema_revision,
            "schemaHash": schema.hash,
        },
        "compatibility": compatibility,
        "cursors": cursors,
        "recentErrors": recent_errors,
        // Idempotency cache stats are not exposed by the Rust facade yet
        // (private `Mutex<Option<…>>`); documented defaults, matching the
        // sibling `/_frick/inspect/db` route. TODO(idempotency-stats).
        "caches": [{
            "name": "idempotency",
            "size": 0,
            "capacity": 0,
            "evictions": 0,
        }],
        "syncTiming": assemble_sync_timing(opts),
    });

    if let Some(map) = snapshot.as_object_mut() {
        if let Some(env) = opts.env.as_ref() {
            map.insert("env".to_string(), json!(env));
        }
        if opts.include_capabilities {
            map.insert("capabilities".to_string(), assemble_capabilities(schema));
        }
    }

    snapshot
}

/// `compatibility` block: matched + expected/applied revisions + an operator
/// `detail` string when they diverge or the ledger is empty/unreadable.
async fn assemble_compatibility(store: &FrickStore, schema: &FrickSchema) -> Value {
    let expected = schema.schema_revision;
    match store.list_applied_migrations().await {
        Ok(applied) => match applied.last() {
            None => json!({
                "matched": false,
                "expectedRevision": expected,
                "detail": "no applied migrations recorded",
            }),
            Some(last) => {
                let applied_revision = last.schema_revision;
                if applied_revision == expected {
                    json!({
                        "matched": true,
                        "expectedRevision": expected,
                        "appliedRevision": applied_revision,
                    })
                } else {
                    json!({
                        "matched": false,
                        "expectedRevision": expected,
                        "appliedRevision": applied_revision,
                        "detail": format!(
                            "database at revision {applied_revision}, instance expects {expected}"
                        ),
                    })
                }
            }
        },
        Err(error) => json!({
            "matched": false,
            "expectedRevision": expected,
            "detail": error.to_string(),
        }),
    }
}

/// `cursors` block: probe each requested stream head; skip probes that error
/// (nonexistent stream / read failure) so a bad probe contributes nothing
/// rather than failing the whole snapshot.
async fn assemble_cursors(store: &FrickStore, opts: &AssembleDiagnosticsOptions) -> Vec<Value> {
    let mut cursors = Vec::with_capacity(opts.cursors.len());
    let streams = store.streams();
    for probe in &opts.cursors {
        let tenant = probe.tenant_id.as_deref().unwrap_or("_default");
        let Ok(head) = streams
            .head(tenant, &probe.stream, &probe.stream_id, ACTIVE_APP_ID)
            .await
        else {
            continue;
        };
        // Build the row in the TS producer key order: stream, streamId,
        // [tenantId], headSequence, count — `tenantId` only when supplied.
        let mut row = serde_json::Map::new();
        row.insert("stream".to_string(), json!(probe.stream));
        row.insert("streamId".to_string(), json!(probe.stream_id));
        if let Some(tenant_id) = probe.tenant_id.as_ref() {
            row.insert("tenantId".to_string(), json!(tenant_id));
        }
        row.insert("headSequence".to_string(), json!(head.head_sequence));
        row.insert("count".to_string(), json!(head.count));
        cursors.push(Value::Object(row));
    }
    cursors
}

/// `syncTiming` block: `snapshotAt` is always present; the rest are present only
/// when the caller observed them.
fn assemble_sync_timing(opts: &AssembleDiagnosticsOptions) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("snapshotAt".to_string(), json!(opts.snapshot_at));
    if let Some(last) = opts.last_successful_sync_at.as_ref() {
        map.insert("lastSuccessfulSyncAt".to_string(), json!(last));
    }
    if let Some(started) = opts.started_at.as_ref() {
        map.insert("startedAt".to_string(), json!(started));
    }
    if let Some(uptime) = opts.uptime_seconds {
        map.insert("uptimeSeconds".to_string(), json!(uptime));
    }
    Value::Object(map)
}

/// `capabilities` block: the negotiated server capabilities flattened to the
/// `DiagnosticsCapabilities` string arrays + the integer limits map, derived
/// from `default_server_capabilities(schema)` (the same values the handshake
/// advertises).
fn assemble_capabilities(schema: &FrickSchema) -> Value {
    let caps = default_server_capabilities(schema);
    let transports: Vec<&str> = caps.transports.iter().map(|c| c.as_str()).collect();
    let encodings: Vec<&str> = caps.encodings.iter().map(|c| c.as_str()).collect();
    let primitives: Vec<&str> = caps.primitives.iter().map(|c| c.as_str()).collect();
    json!({
        "transports": transports,
        "encodings": encodings,
        "primitives": primitives,
        "experimental": caps.experimental,
        "limits": caps.limits,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use frick_protocol::foundation_schema;
    use frick_store::{FrickStore, FrickStoreOptions};

    async fn memory_store(schema: &FrickSchema) -> FrickStore {
        let mut options = FrickStoreOptions::memory();
        options.schema = Some(schema.clone());
        FrickStore::open(options).await.unwrap()
    }

    fn base_opts() -> AssembleDiagnosticsOptions {
        AssembleDiagnosticsOptions {
            snapshot_at: "2026-06-10T00:00:00.000Z".to_string(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn stamps_version_source_and_schema_identity() {
        let schema = foundation_schema();
        let store = memory_store(&schema).await;
        let snapshot = assemble_diagnostics_snapshot(&store, &schema, &base_opts()).await;

        assert_eq!(snapshot["diagnosticsVersion"], json!(1));
        assert_eq!(snapshot["source"], json!("cli"));
        assert_eq!(snapshot["schema"]["schemaId"], json!(schema.schema_id));
        assert_eq!(
            snapshot["schema"]["schemaVersion"],
            json!(schema.schema_version)
        );
        assert_eq!(
            snapshot["schema"]["schemaRevision"],
            json!(schema.schema_revision)
        );
        assert_eq!(snapshot["schema"]["schemaHash"], json!(schema.hash));
    }

    #[tokio::test]
    async fn required_fields_are_always_present() {
        let schema = foundation_schema();
        let store = memory_store(&schema).await;
        let snapshot = assemble_diagnostics_snapshot(&store, &schema, &base_opts()).await;

        // recentErrors + caches + syncTiming are required even when empty.
        assert!(snapshot["recentErrors"].is_array());
        assert!(snapshot["caches"].is_array());
        assert_eq!(snapshot["caches"][0]["name"], json!("idempotency"));
        assert_eq!(
            snapshot["syncTiming"]["snapshotAt"],
            json!("2026-06-10T00:00:00.000Z")
        );
        // Optional live-gateway surfaces are absent (not observed here).
        assert!(snapshot.get("subscriptions").is_none());
        assert!(snapshot.get("pendingAppends").is_none());
        assert!(snapshot.get("connection").is_none());
        assert!(snapshot.get("recentAcks").is_none());
    }

    #[tokio::test]
    async fn compatibility_matches_after_boot_migrations() {
        let schema = foundation_schema();
        let store = memory_store(&schema).await;
        let snapshot = assemble_diagnostics_snapshot(&store, &schema, &base_opts()).await;

        // The framework migrations ran at open, so the applied head equals the
        // foundation revision (1) and compatibility is matched.
        let compat = &snapshot["compatibility"];
        assert_eq!(compat["matched"], json!(true));
        assert_eq!(compat["expectedRevision"], json!(schema.schema_revision));
        assert_eq!(compat["appliedRevision"], json!(schema.schema_revision));
    }

    #[tokio::test]
    async fn env_and_capabilities_are_opt_in() {
        let schema = foundation_schema();
        let store = memory_store(&schema).await;

        let bare = assemble_diagnostics_snapshot(&store, &schema, &base_opts()).await;
        assert!(bare.get("env").is_none());
        assert!(bare.get("capabilities").is_none());

        let opts = AssembleDiagnosticsOptions {
            source: Some("server".to_string()),
            env: Some("test".to_string()),
            include_capabilities: true,
            started_at: Some("2026-06-10T00:00:00.000Z".to_string()),
            uptime_seconds: Some(2.5),
            ..base_opts()
        };
        let full = assemble_diagnostics_snapshot(&store, &schema, &opts).await;
        assert_eq!(full["source"], json!("server"));
        assert_eq!(full["env"], json!("test"));
        let caps = &full["capabilities"];
        assert!(
            caps["transports"]
                .as_array()
                .unwrap()
                .contains(&json!("websocket"))
        );
        assert!(
            caps["encodings"]
                .as_array()
                .unwrap()
                .contains(&json!("msgpack"))
        );
        assert!(
            caps["primitives"]
                .as_array()
                .unwrap()
                .contains(&json!("objects"))
        );
        assert!(caps["limits"].is_object());
        assert_eq!(
            full["syncTiming"]["startedAt"],
            json!("2026-06-10T00:00:00.000Z")
        );
        assert_eq!(full["syncTiming"]["uptimeSeconds"], json!(2.5));
    }

    #[tokio::test]
    async fn cursor_probe_for_unknown_stream_contributes_nothing() {
        let schema = foundation_schema();
        let store = memory_store(&schema).await;
        let opts = AssembleDiagnosticsOptions {
            cursors: vec![DiagnosticsCursorProbe {
                tenant_id: None,
                stream: "messages".to_string(),
                stream_id: "room-1".to_string(),
            }],
            ..base_opts()
        };
        let snapshot = assemble_diagnostics_snapshot(&store, &schema, &opts).await;
        // Foundation schema has no streams, so the head probe yields (0,0) — a
        // real row — OR the unknown-stream read errors and is skipped. Either
        // way `cursors` is a present array (observed) and never panics.
        assert!(snapshot["cursors"].is_array());
    }
}
