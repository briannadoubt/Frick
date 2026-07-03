//! `StreamStore` (`apps/server/src/storage/stream-store.ts`, map 03 §8.2).
//!
//! The durable, app-and-tenant-partitioned event log. `append` is idempotent:
//! a front-cache ([`BoundedIdempotencyCache`]) backed by the durable
//! `idempotency_keys` table dedups replays of the same
//! `(app_id, tenant_id, replica_id, request_id)` within the replay window.
//!
//! App partitioning (FR-37): every read filters by `app_id` and every write
//! stamps it. The `stream_events` PRIMARY KEY
//! `(tenant_id, stream_type, stream_id, sequence)` does NOT include `app_id`,
//! so the sequence space is SHARED across apps for a given
//! `(tenant, stream, streamId)` — two apps writing the same key mint distinct,
//! monotonically increasing sequences and never collide on the PK. Isolation
//! is enforced on the read side. The `idempotency_keys` PK includes `app_id`
//! (migration 0023), so two apps sharing a `(tenant, replica, request)` tuple
//! occupy distinct rows.
//!
//! Clock & ids (map 03 §16): the TS class calls `new Date().toISOString()` and
//! `randomUUID()` inline. Here `append` takes an explicit `now_ms` (rendered to
//! the same ISO-8601 millisecond `Z` string) and the full `event_id` as a
//! parameter, so store logic never reads the system clock or a random source.

use frick_protocol::{
    FrickSchema, PackedStreamEvent, ProtocolError, StreamEventInput, Value, pack_stream_event,
    unpack_stream_event,
};

use crate::driver::SqlDriver;
use crate::encryption::AtRestEncryption;
use crate::error::StoreError;
use crate::packed::{decode_packed, encode_packed};
use crate::stores::blob_bytes::iso_from_epoch_ms;
use crate::stores::idempotency::BoundedIdempotencyCache;

/// A stored stream event — the unpacked [`StreamEventInput`] plus its tenant
/// and app partition (`StoredEvent` in TS, `stream-store.ts:30-35`).
#[derive(Debug, Clone, PartialEq)]
pub struct StoredEvent {
    /// `stream`, `streamId`, `sequence`, `eventId`, `event`, `payload`.
    pub event: StreamEventInput,
    pub tenant_id: String,
    /// App partition the event belongs to (FR-37); [`DEFAULT_APP_ID`] for
    /// single-app deployments.
    pub app_id: String,
}

/// Result of [`StreamStore::append`] (`AppendResult` in TS).
#[derive(Debug, Clone, PartialEq)]
pub struct AppendResult {
    pub event: StoredEvent,
    pub created: bool,
}

/// Value cached in the in-process idempotency front-cache
/// (`CachedIdempotentEvent`, `stream-store.ts:49-52`). The `created_at_ms`
/// timestamp lets the replay-window bound be enforced against cached hits too.
#[derive(Debug, Clone)]
pub struct CachedIdempotentEvent {
    pub event: StoredEvent,
    pub created_at_ms: f64,
}

/// Opt-in retention policy for a single stream type (FR-145,
/// `StreamRetentionPolicy`). Streams absent from the policy map keep their full
/// history (the safe default).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StreamRetentionPolicy {
    /// Delete events whose `created_at` is older than this many ms.
    pub max_age_ms: Option<i64>,
    /// Keep only the newest N events per `(tenant, stream, streamId)`.
    pub max_events: Option<i64>,
    /// Optional tenant scope (server-storage-7). Omit for server-wide.
    pub tenant_id: Option<String>,
    /// Optional app scope (server-storage-7). Omit for server-wide (all apps).
    pub app_id: Option<String>,
}

/// Counts returned by [`StreamStore::prune_retention`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct StreamRetentionPruneResult {
    pub pruned_by_age: u64,
    pub pruned_by_count: u64,
}

/// Sentinel written to the SQL `event_type` column by
/// [`StreamStore::redact_event`] (AURA-191). Purely an audit/introspection
/// marker on the raw row — readers never match against it directly, because
/// `unpack_stream_event` decodes the event's identity from the still-intact
/// packed tuple, not this column.
pub const REDACTED_EVENT_TYPE_MARKER: &str = "__redacted__";

/// The durable stream-event store. Borrows the driver and schema for its
/// lifetime, plus an optional mutable idempotency front-cache and a replay
/// window (`replay_window_ms`, `> 0` to enable; `<= 0`/`None` disables the
/// lookup-time bound, the legacy behaviour).
pub struct StreamStore<'a> {
    sql: &'a SqlDriver,
    schema: &'a FrickSchema,
    replay_window_ms: Option<i64>,
    /// Optional at-rest encryption engine (AURA-436, extending AURA-328).
    /// When set, the packed event tuple is sealed under the tenant-derived
    /// key before it hits the `stream_events.packed` column and opened on
    /// every read (legacy plaintext rows pass through untouched).
    encryption: Option<&'a AtRestEncryption>,
}

impl<'a> StreamStore<'a> {
    /// Construct a store. `replay_window_ms` mirrors the TS
    /// `windowOptions.replayWindowMs`: only a finite value `> 0` enables the
    /// lookup-time replay-window bound; otherwise it is disabled.
    #[must_use]
    pub fn new(sql: &'a SqlDriver, schema: &'a FrickSchema, replay_window_ms: Option<i64>) -> Self {
        let replay_window_ms = replay_window_ms.filter(|window| *window > 0);
        Self {
            sql,
            schema,
            replay_window_ms,
            encryption: None,
        }
    }

    /// Attach (or detach) the at-rest encryption engine. The facade threads
    /// its configured engine through here so every `streams()` view encrypts
    /// consistently; `None` keeps the historical plaintext behavior.
    #[must_use]
    pub const fn with_encryption(mut self, encryption: Option<&'a AtRestEncryption>) -> Self {
        self.encryption = encryption;
        self
    }

    /// Seal an encoded packed tuple for `tenant_id`, or pass it through when
    /// no encryption engine is attached (or no key is active).
    fn seal_packed(&self, tenant_id: &str, encoded: Vec<u8>) -> Result<Vec<u8>, StoreError> {
        match self.encryption {
            Some(encryption) => encryption.encrypt(tenant_id, &encoded),
            None => Ok(encoded),
        }
    }

    /// Open a stored `packed` column value: enveloped bytes decrypt under the
    /// tenant-derived key, legacy plaintext passes through verbatim.
    fn open_packed(&self, tenant_id: &str, stored: &[u8]) -> Result<Vec<u8>, StoreError> {
        match self.encryption {
            Some(encryption) => encryption.decrypt(tenant_id, stored),
            None => Ok(stored.to_vec()),
        }
    }

    /// True when `created_at_ms` falls within the configured replay window
    /// relative to `now_ms` (`#withinReplayWindow`, `stream-store.ts:143-153`).
    /// With no window configured every record is in-window. An unparseable
    /// (non-finite) timestamp fails closed — treated as expired.
    fn within_replay_window(&self, created_at_ms: f64, now_ms: i64) -> bool {
        let Some(window) = self.replay_window_ms else {
            return true;
        };
        if !created_at_ms.is_finite() {
            // Can't prove it is within the window, so fail closed.
            return false;
        }
        // Epoch-ms and window are well within f64's exact-integer range
        // (2^53), so the comparison is exact for any realistic timestamp.
        #[allow(clippy::cast_precision_loss)]
        let (now, window) = (now_ms as f64, window as f64);
        now - created_at_ms <= window
    }

    /// Append an event, deduping replays of the same
    /// `(app_id, tenant_id, replica_id, request_id)`. `now_ms` stamps
    /// `created_at`; `event_id` is the pre-generated id (TS uses
    /// `"event-" + randomUUID()`). The optional `cache` is the in-process
    /// front-cache — pass the same cache across calls to dedup without a SQL
    /// round-trip.
    ///
    /// ⚠️ The next-sequence read and the INSERT are deliberately NOT wrapped in
    /// a transaction, matching TS: a concurrent in-process append interleaving
    /// at an await point could mint a duplicate sequence and fail on the PK
    /// (no retry logic). The `_default` single-writer case is unaffected.
    #[allow(clippy::too_many_arguments)]
    pub async fn append(
        &self,
        tenant_id: &str,
        stream: &str,
        stream_id: &str,
        replica_id: &str,
        request_id: &str,
        event: &str,
        payload: &Value,
        app_id: &str,
        event_id: &str,
        now_ms: i64,
        mut cache: Option<&mut BoundedIdempotencyCache<CachedIdempotentEvent>>,
    ) -> Result<AppendResult, StoreError> {
        let cache_key = format!("{app_id}|{tenant_id}|{replica_id}|{request_id}");

        // 1. Front-cache hit within the replay window.
        if let Some(cache) = cache.as_deref_mut()
            && let Some(cached) = cache.get(&cache_key)
            && self.within_replay_window(cached.created_at_ms, now_ms)
        {
            return Ok(AppendResult {
                event: cached.event.clone(),
                created: false,
            });
        }

        // 2. Durable lookup.
        if let Some(existing) = self
            .read_idempotent_event(app_id, tenant_id, replica_id, request_id, now_ms)
            .await?
        {
            let event = existing.event.clone();
            if let Some(cache) = cache {
                cache.set(cache_key, existing);
            }
            return Ok(AppendResult {
                event,
                created: false,
            });
        }

        // 3. Next sequence (NOT app-filtered — shared sequence space).
        let sequence = self.next_sequence(tenant_id, stream, stream_id).await?;
        let wire_event = StreamEventInput {
            stream: stream.to_string(),
            stream_id: stream_id.to_string(),
            sequence,
            event_id: event_id.to_string(),
            event: event.to_string(),
            payload: payload.clone(),
        };
        let packed =
            pack_stream_event(self.schema, &wire_event).map_err(|err| protocol_error(&err))?;
        let stored_packed = self.seal_packed(tenant_id, encode_packed(&packed)?)?;
        let created_at = iso_from_epoch_ms(now_ms);

        // 4. INSERT the event — exact column order from map 03 §8.2.
        self.sql
            .run(
                "INSERT INTO stream_events
          (app_id, tenant_id, stream_type, stream_id, sequence, event_id, event_type, packed, replica_id, request_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                &[
                    app_id.into(),
                    tenant_id.into(),
                    stream.into(),
                    stream_id.into(),
                    sequence.into(),
                    event_id.into(),
                    event.into(),
                    stored_packed.into(),
                    replica_id.into(),
                    request_id.into(),
                    created_at.clone().into(),
                ],
            )
            .await?;

        // 5. UPSERT the idempotency row (upsert, not insert: a beyond-window
        // replay mints a fresh event but the stale row may still exist — rewrite
        // it to point at the new event with a fresh created_at).
        self.sql
            .run(
                "INSERT INTO idempotency_keys
          (app_id, tenant_id, replica_id, request_id, result_event_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(app_id, tenant_id, replica_id, request_id)
          DO UPDATE SET result_event_id = excluded.result_event_id, created_at = excluded.created_at",
                &[
                    app_id.into(),
                    tenant_id.into(),
                    replica_id.into(),
                    request_id.into(),
                    event_id.into(),
                    created_at.clone().into(),
                ],
            )
            .await?;

        let event = StoredEvent {
            event: wire_event,
            tenant_id: tenant_id.to_string(),
            app_id: app_id.to_string(),
        };
        if let Some(cache) = cache {
            cache.set(
                cache_key,
                CachedIdempotentEvent {
                    event: event.clone(),
                    created_at_ms: parse_iso_ms(&created_at),
                },
            );
        }
        Ok(AppendResult {
            event,
            created: true,
        })
    }

    /// Iterate every event for a stream type within a tenant, across all
    /// `streamId`s, ordered `(stream_id, sequence)` (`listAllByStreamType`).
    pub async fn list_all_by_stream_type(
        &self,
        tenant_id: &str,
        stream: &str,
        app_id: &str,
    ) -> Result<Vec<StoredEvent>, StoreError> {
        let rows = self
            .sql
            .all(
                "SELECT packed FROM stream_events
          WHERE app_id = ? AND tenant_id = ? AND stream_type = ?
          ORDER BY stream_id ASC, sequence ASC",
                &[app_id.into(), tenant_id.into(), stream.into()],
            )
            .await?;
        self.map_events(&rows, tenant_id, app_id)
    }

    /// Every event for a tenant, ordered `(stream_type, stream_id, sequence)`
    /// (`listAll`).
    pub async fn list_all(
        &self,
        tenant_id: &str,
        app_id: &str,
    ) -> Result<Vec<StoredEvent>, StoreError> {
        let rows = self
            .sql
            .all(
                "SELECT packed FROM stream_events
          WHERE app_id = ? AND tenant_id = ?
          ORDER BY stream_type ASC, stream_id ASC, sequence ASC",
                &[app_id.into(), tenant_id.into()],
            )
            .await?;
        self.map_events(&rows, tenant_id, app_id)
    }

    /// After-cursor read: events with `sequence > after`, ascending. `limit`,
    /// when given, is clamped `>= 1` (a non-finite limit becomes 1, matching
    /// the TS `Math.max(1, Math.floor(...))`).
    pub async fn read(
        &self,
        tenant_id: &str,
        stream: &str,
        stream_id: &str,
        after: i64,
        limit: Option<i64>,
        app_id: &str,
    ) -> Result<Vec<StoredEvent>, StoreError> {
        let rows = match limit {
            None => {
                self.sql
                    .all(
                        "SELECT packed FROM stream_events
          WHERE app_id = ? AND tenant_id = ? AND stream_type = ? AND stream_id = ? AND sequence > ?
          ORDER BY sequence ASC",
                        &[
                            app_id.into(),
                            tenant_id.into(),
                            stream.into(),
                            stream_id.into(),
                            after.into(),
                        ],
                    )
                    .await?
            }
            Some(limit) => {
                let clamped = limit.max(1);
                self.sql
                    .all(
                        "SELECT packed FROM stream_events
          WHERE app_id = ? AND tenant_id = ? AND stream_type = ? AND stream_id = ? AND sequence > ?
          ORDER BY sequence ASC
          LIMIT ?",
                        &[
                            app_id.into(),
                            tenant_id.into(),
                            stream.into(),
                            stream_id.into(),
                            after.into(),
                            clamped.into(),
                        ],
                    )
                    .await?
            }
        };
        self.map_events(&rows, tenant_id, app_id)
    }

    /// Cheap cursor probe (FR-116): highest `sequence` and total count for a
    /// stream without unpacking payloads. Empty/unknown ⇒ `(0, 0)`.
    pub async fn head(
        &self,
        tenant_id: &str,
        stream: &str,
        stream_id: &str,
        app_id: &str,
    ) -> Result<StreamHead, StoreError> {
        let row = self
            .sql
            .get(
                "SELECT COALESCE(MAX(sequence), 0) AS head, COUNT(*) AS count
          FROM stream_events WHERE app_id = ? AND tenant_id = ? AND stream_type = ? AND stream_id = ?",
                &[app_id.into(), tenant_id.into(), stream.into(), stream_id.into()],
            )
            .await?
            .ok_or_else(|| StoreError::driver("stream head aggregate returned no row"))?;
        Ok(StreamHead {
            head_sequence: row.i64("head").unwrap_or(0),
            count: row.i64("count").unwrap_or(0),
        })
    }

    /// Backwards-paginated read: up to `limit` events with `sequence < before`,
    /// returned oldest-first. `limit` is clamped to `[1, 500]`; a non-finite or
    /// `<= 0` `before` becomes the `Number.MAX_SAFE_INTEGER` sentinel
    /// (`readBefore`, `stream-store.ts:329-353`).
    pub async fn read_before(
        &self,
        tenant_id: &str,
        stream: &str,
        stream_id: &str,
        before: i64,
        limit: i64,
        app_id: &str,
    ) -> Result<Vec<StoredEvent>, StoreError> {
        let clamped = limit.clamp(1, 500);
        // `Number.MAX_SAFE_INTEGER` (2^53 - 1) — the TS sentinel for a
        // non-finite / non-positive `before`.
        let cutoff = if before > 0 {
            before
        } else {
            9_007_199_254_740_991
        };
        let rows = self
            .sql
            .all(
                "SELECT packed FROM stream_events
          WHERE app_id = ? AND tenant_id = ? AND stream_type = ? AND stream_id = ? AND sequence < ?
          ORDER BY sequence DESC
          LIMIT ?",
                &[
                    app_id.into(),
                    tenant_id.into(),
                    stream.into(),
                    stream_id.into(),
                    cutoff.into(),
                    clamped.into(),
                ],
            )
            .await?;
        let mut events = self.map_events(&rows, tenant_id, app_id)?;
        events.reverse();
        Ok(events)
    }

    /// Durable idempotency lookup (`readIdempotentEvent`). Enforces the
    /// replay-window bound at lookup time: a record whose `created_at` is older
    /// than the window — or unparseable — is treated as not-seen even if its row
    /// still exists.
    async fn read_idempotent_event(
        &self,
        app_id: &str,
        tenant_id: &str,
        replica_id: &str,
        request_id: &str,
        now_ms: i64,
    ) -> Result<Option<CachedIdempotentEvent>, StoreError> {
        let Some(row) = self
            .sql
            .get(
                "SELECT result_event_id, created_at FROM idempotency_keys WHERE app_id = ? AND tenant_id = ? AND replica_id = ? AND request_id = ?",
                &[app_id.into(), tenant_id.into(), replica_id.into(), request_id.into()],
            )
            .await?
        else {
            return Ok(None);
        };
        let created_at = row
            .text("created_at")
            .ok_or_else(|| StoreError::driver("idempotency_keys.created_at missing"))?;
        let created_at_ms = parse_iso_ms(created_at);
        if !self.within_replay_window(created_at_ms, now_ms) {
            return Ok(None);
        }
        let result_event_id = row
            .text("result_event_id")
            .ok_or_else(|| StoreError::driver("idempotency_keys.result_event_id missing"))?
            .to_string();
        let event = self
            .read_by_event_id(app_id, tenant_id, &result_event_id)
            .await?;
        Ok(event.map(|event| CachedIdempotentEvent {
            event,
            created_at_ms,
        }))
    }

    async fn read_by_event_id(
        &self,
        app_id: &str,
        tenant_id: &str,
        event_id: &str,
    ) -> Result<Option<StoredEvent>, StoreError> {
        let Some(row) = self
            .sql
            .get(
                "SELECT packed FROM stream_events WHERE app_id = ? AND tenant_id = ? AND event_id = ?",
                &[app_id.into(), tenant_id.into(), event_id.into()],
            )
            .await?
        else {
            return Ok(None);
        };
        Ok(Some(self.unpack_row(&row, tenant_id, app_id)?))
    }

    /// Next sequence for a `(tenant, stream, streamId)` — `COALESCE(MAX, 0) + 1`,
    /// deliberately NOT app-filtered (the PK excludes `app_id`, so the sequence
    /// space is shared across apps; `nextSequence`, `stream-store.ts:394-411`).
    async fn next_sequence(
        &self,
        tenant_id: &str,
        stream: &str,
        stream_id: &str,
    ) -> Result<i64, StoreError> {
        let row = self
            .sql
            .get(
                "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
          FROM stream_events WHERE tenant_id = ? AND stream_type = ? AND stream_id = ?",
                &[tenant_id.into(), stream.into(), stream_id.into()],
            )
            .await?
            .ok_or_else(|| StoreError::driver("next_sequence aggregate returned no row"))?;
        Ok(row.i64("next_sequence").unwrap_or(1))
    }

    /// Apply opt-in per-stream retention (FR-145, `pruneRetention`). Only stream
    /// types present in `policies` are touched. `now_ms` is the clock the
    /// age-based cutoff is computed against (TS takes a `now()` override per
    /// call).
    ///
    /// server-storage-7 — BLAST RADIUS: a policy with `max_age_ms`/`max_events`
    /// but no `tenant_id`/`app_id` prunes the stream type's events across EVERY
    /// tenant and app uniformly. Setting `policy.tenant_id` / `policy.app_id`
    /// bounds BOTH the age-based and count-based DELETE to that scope.
    pub async fn prune_retention(
        &self,
        policies: &[(&str, StreamRetentionPolicy)],
        now_ms: i64,
    ) -> Result<StreamRetentionPruneResult, StoreError> {
        let mut pruned_by_age: u64 = 0;
        let mut pruned_by_count: u64 = 0;
        for (stream_type, policy) in policies {
            // Optional tenant/app scoping: append `AND tenant_id = ?` /
            // `AND app_id = ?` and their params when present.
            let mut scope_sql = String::new();
            let mut scope_params: Vec<crate::driver::SqlValue> = Vec::new();
            if let Some(tenant_id) = &policy.tenant_id {
                scope_sql.push_str(" AND tenant_id = ?");
                scope_params.push(tenant_id.clone().into());
            }
            if let Some(app_id) = &policy.app_id {
                scope_sql.push_str(" AND app_id = ?");
                scope_params.push(app_id.clone().into());
            }

            if let Some(max_age_ms) = policy.max_age_ms
                && max_age_ms > 0
            {
                let cutoff = iso_from_epoch_ms(now_ms - max_age_ms);
                let mut params: Vec<crate::driver::SqlValue> =
                    vec![(*stream_type).into(), cutoff.into()];
                params.extend(scope_params.iter().cloned());
                let result = self
                    .sql
                    .run(
                        &format!(
                            "DELETE FROM stream_events WHERE stream_type = ? AND created_at < ?{scope_sql}"
                        ),
                        &params,
                    )
                    .await?;
                pruned_by_age += result.changes;
            }
            if let Some(max_events) = policy.max_events
                && max_events >= 0
            {
                // Keep only the newest `max_events` per stream_id: delete rows
                // whose sequence is at or below (this stream_id's max sequence)
                // - max_events. The correlated subquery sees the pre-delete
                // snapshot, so the per-stream max is stable.
                let mut params: Vec<crate::driver::SqlValue> =
                    vec![(*stream_type).into(), max_events.into()];
                params.extend(scope_params.iter().cloned());
                let result = self
                    .sql
                    .run(
                        &format!(
                            "DELETE FROM stream_events
              WHERE stream_type = ?
                AND sequence <= (
                  SELECT MAX(s2.sequence) FROM stream_events s2
                  WHERE s2.tenant_id = stream_events.tenant_id
                    AND s2.stream_type = stream_events.stream_type
                    AND s2.stream_id = stream_events.stream_id
                ) - ?{scope_sql}"
                        ),
                        &params,
                    )
                    .await?;
                pruned_by_count += result.changes;
            }
        }
        Ok(StreamRetentionPruneResult {
            pruned_by_age,
            pruned_by_count,
        })
    }

    /// Redact a single event's payload in place, preserving sequence
    /// integrity (AURA-191 — the stream-side counterpart to
    /// [`ObjectStore::delete_by_field`](crate::stores::object::ObjectStore::delete_by_field)
    /// used by account-deletion cascades).
    ///
    /// Unlike a hard delete, the row's identity — `(tenant_id, stream_type,
    /// stream_id, sequence)` — and its `event_id` are left untouched, so
    /// every other member's cursor (`read`/`read_before`'s `after`/`before`
    /// bounds, [`head`](Self::head)) keeps working exactly as if the event
    /// were still there: no gap, no renumbering, no other row shifts. Only
    /// the event's fields are erased — decoding a redacted row now yields an
    /// empty payload map (`unpack_stream_event` still succeeds; it just finds
    /// zero packed fields). `event_type` in SQL is stamped with
    /// [`REDACTED_EVENT_TYPE_MARKER`] purely for audit/introspection; the
    /// stream/event identity actually read back comes from the still-intact
    /// packed tuple, so existing readers never choke on an unknown event
    /// name. A no-op redact (already redacted, or absent) is idempotent and
    /// returns `false` only when no row exists at that address.
    pub async fn redact_event(
        &self,
        tenant_id: &str,
        stream: &str,
        stream_id: &str,
        sequence: i64,
        app_id: &str,
    ) -> Result<bool, StoreError> {
        let Some(row) = self
            .sql
            .get(
                "SELECT packed FROM stream_events
          WHERE app_id = ? AND tenant_id = ? AND stream_type = ? AND stream_id = ? AND sequence = ?",
                &[
                    app_id.into(),
                    tenant_id.into(),
                    stream.into(),
                    stream_id.into(),
                    sequence.into(),
                ],
            )
            .await?
        else {
            return Ok(false);
        };
        let opened = self.open_packed(
            tenant_id,
            row.blob("packed")
                .ok_or_else(|| StoreError::driver("stream_events.packed missing"))?,
        )?;
        let packed: PackedStreamEvent = decode_packed(&opened)?;
        // Keep every identity component (stream type id, stream key, sequence,
        // event id, event type id) — only the field payload is dropped.
        let tombstoned: PackedStreamEvent =
            (packed.0, packed.1, packed.2, packed.3, packed.4, Vec::new());
        let encoded = self.seal_packed(tenant_id, encode_packed(&tombstoned)?)?;

        let result = self
            .sql
            .run(
                "UPDATE stream_events SET packed = ?, event_type = ?
          WHERE app_id = ? AND tenant_id = ? AND stream_type = ? AND stream_id = ? AND sequence = ?",
                &[
                    encoded.into(),
                    REDACTED_EVENT_TYPE_MARKER.into(),
                    app_id.into(),
                    tenant_id.into(),
                    stream.into(),
                    stream_id.into(),
                    sequence.into(),
                ],
            )
            .await?;
        Ok(result.changes > 0)
    }

    /// Redact every event authored by `field == value` (e.g. `senderId`)
    /// across an entire stream type within a tenant/app — the id-enumeration
    /// step an account-deletion cascade needs to erase a user's authored
    /// content from streams shared with other members, without disturbing
    /// any other member's events or sequence numbers. Returns the count
    /// redacted.
    ///
    /// Same scan-then-filter shape as
    /// [`ObjectStore::delete_by_field`](crate::stores::object::ObjectStore::delete_by_field):
    /// the field lives inside the packed payload, not a SQL column, so there
    /// is no indexed `UPDATE ... WHERE` — list every event of the stream
    /// type, filter the unpacked payload in app code, then redact each match
    /// by its exact `(stream_id, sequence)` address.
    pub async fn redact_by_field(
        &self,
        tenant_id: &str,
        stream: &str,
        app_id: &str,
        field: &str,
        value: &str,
    ) -> Result<u64, StoreError> {
        let events = self
            .list_all_by_stream_type(tenant_id, stream, app_id)
            .await?;
        let mut redacted = 0u64;
        for stored in events {
            if !event_field_eq(&stored.event.payload, field, value) {
                continue;
            }
            if self
                .redact_event(
                    tenant_id,
                    stream,
                    &stored.event.stream_id,
                    stored.event.sequence,
                    app_id,
                )
                .await?
            {
                redacted += 1;
            }
        }
        Ok(redacted)
    }

    fn map_events(
        &self,
        rows: &[crate::driver::SqlRow],
        tenant_id: &str,
        app_id: &str,
    ) -> Result<Vec<StoredEvent>, StoreError> {
        rows.iter()
            .map(|row| self.unpack_row(row, tenant_id, app_id))
            .collect()
    }

    fn unpack_row(
        &self,
        row: &crate::driver::SqlRow,
        tenant_id: &str,
        app_id: &str,
    ) -> Result<StoredEvent, StoreError> {
        let opened = self.open_packed(
            tenant_id,
            row.blob("packed")
                .ok_or_else(|| StoreError::driver("stream_events.packed missing"))?,
        )?;
        let packed: PackedStreamEvent = decode_packed(&opened)?;
        let event =
            unpack_stream_event(self.schema, &packed).map_err(|err| protocol_error(&err))?;
        Ok(StoredEvent {
            event,
            tenant_id: tenant_id.to_string(),
            app_id: app_id.to_string(),
        })
    }
}

/// Result of [`StreamStore::head`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct StreamHead {
    pub head_sequence: i64,
    pub count: i64,
}

/// Parse an ISO-8601 millisecond timestamp to epoch ms as JS `Date.parse` does
/// for the canonical `toISOString()` form (`YYYY-MM-DDTHH:mm:ss.sssZ`). Returns
/// `f64::NAN` for anything it can't parse — the unparseable case that
/// [`StreamStore::within_replay_window`] fails closed on (TS `Date.parse`
/// returns `NaN`).
fn parse_iso_ms(text: &str) -> f64 {
    // Epoch-ms stays within f64's exact-integer range for any realistic
    // timestamp, so the conversion is lossless in practice (mirrors JS, which
    // holds time in an f64 `number`).
    #[allow(clippy::cast_precision_loss)]
    parse_iso_ms_opt(text).map_or(f64::NAN, |ms| ms as f64)
}

/// Parse the canonical `YYYY-MM-DDTHH:mm:ss.sssZ` shape; `None` on any
/// deviation (which surfaces as `NaN` to callers).
fn parse_iso_ms_opt(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    // Exact length of `YYYY-MM-DDTHH:mm:ss.sssZ`.
    if bytes.len() != 24 {
        return None;
    }
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
    {
        return None;
    }
    let year = parse_digits(&bytes[0..4])?;
    let month = parse_digits(&bytes[5..7])?;
    let day = parse_digits(&bytes[8..10])?;
    let hour = parse_digits(&bytes[11..13])?;
    let minute = parse_digits(&bytes[14..16])?;
    let second = parse_digits(&bytes[17..19])?;
    let millis = parse_digits(&bytes[20..23])?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some(days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000 + millis)
}

fn parse_digits(bytes: &[u8]) -> Option<i64> {
    let mut value: i64 = 0;
    for &byte in bytes {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value * 10 + i64::from(byte - b'0');
    }
    Some(value)
}

/// Proleptic-Gregorian (year, month, day) → days since the Unix epoch; the
/// inverse of `civil_from_days` (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// TS protocol helpers throw plain `Error`s; their `Display` text is the
/// contract, so the message carries over verbatim.
fn protocol_error(err: &ProtocolError) -> StoreError {
    StoreError::store(err.message())
}

/// `true` when the event's unpacked payload map has `field` equal (as a
/// string) to `expected` — the stream-event sibling of
/// `object.rs`'s `object_field_eq`, used by
/// [`StreamStore::redact_by_field`]. Misses on absent fields, non-string
/// values, or an already-redacted (empty) payload.
fn event_field_eq(payload: &Value, field: &str, expected: &str) -> bool {
    payload.as_map().is_some_and(|entries| {
        entries
            .iter()
            .any(|(key, value)| key.as_str() == Some(field) && value.as_str() == Some(expected))
    })
}

#[cfg(test)]
mod tests {
    use frick_protocol::schema::{EventDef, FieldDef, FieldKind, StreamDef};

    use super::*;
    use crate::stores::blob_bytes::DEFAULT_APP_ID;

    // ── Test schema (productTestSchema subset: MessageStream + MessageSent) ──
    // `packages/protocol/src/fixtures/product-test-schema.ts`.

    const TENANT: &str = "_default";
    const STREAM: &str = "MessageStream";
    const EVENT: &str = "MessageSent";
    const NOW: i64 = 1_700_000_000_000;

    fn field(id: i64, name: &str, kind: FieldKind, required: bool) -> FieldDef {
        FieldDef {
            id,
            name: name.into(),
            kind,
            required,
            ref_: None,
            enum_values: None,
            sensitivity: None,
        }
    }

    fn ref_field(id: i64, name: &str, target: &str) -> FieldDef {
        FieldDef {
            ref_: Some(target.into()),
            ..field(id, name, FieldKind::Ref, true)
        }
    }

    fn test_schema() -> FrickSchema {
        FrickSchema {
            name: "product-test".into(),
            schema_id: "product-test".into(),
            schema_version: "1.0.0".into(),
            schema_revision: 1,
            minimum_client_revision: 1,
            minimum_server_revision: 1,
            protocol: "frick.realtime".into(),
            protocol_version: 1,
            compatibility: "greenfield-cutover".into(),
            hash: "test-hash".into(),
            objects: vec![],
            streams: vec![StreamDef {
                id: 1,
                name: STREAM.into(),
                key_fields: vec![ref_field(1, "conversationId", "Conversation")],
                events: vec![EVENT.into()],
            }],
            events: vec![EventDef {
                id: 1,
                name: EVENT.into(),
                fields: vec![
                    field(1, "messageId", FieldKind::Id, true),
                    ref_field(2, "senderId", "User"),
                    field(3, "body", FieldKind::String, true),
                    field(4, "createdAt", FieldKind::Timestamp, true),
                    field(5, "attachmentBlobIds", FieldKind::Json, false),
                ],
            }],
            presences: vec![],
            signals: vec![],
            blobs: vec![],
            jobs: vec![],
            projections: vec![],
        }
    }

    /// Effective DDL for `stream_events` + `idempotency_keys` (map 03 §5;
    /// post-all-migrations SQLite spelling). The driver runs `foreign_keys=OFF`.
    const DDL: &str = "
      CREATE TABLE stream_events (
        tenant_id TEXT NOT NULL DEFAULT '_default',
        stream_type TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        packed BLOB NOT NULL,
        replica_id TEXT,
        request_id TEXT,
        created_at TEXT NOT NULL,
        app_id TEXT NOT NULL DEFAULT '_default',
        PRIMARY KEY (tenant_id, stream_type, stream_id, sequence)
      );
      CREATE UNIQUE INDEX idx_stream_events_tenant_event_id
        ON stream_events (tenant_id, event_id);
      CREATE INDEX idx_stream_events_app_tenant
        ON stream_events (app_id, tenant_id, stream_type, stream_id, sequence);
      CREATE INDEX idx_stream_events_app_tenant_event_id
        ON stream_events (app_id, tenant_id, event_id);
      CREATE TABLE idempotency_keys (
        app_id TEXT NOT NULL DEFAULT '_default',
        tenant_id TEXT NOT NULL DEFAULT '_default',
        replica_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        result_event_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (app_id, tenant_id, replica_id, request_id)
      );
      CREATE INDEX idx_idempotency_keys_created_at ON idempotency_keys (created_at);
      CREATE INDEX idx_idempotency_keys_app_tenant
        ON idempotency_keys (app_id, tenant_id, replica_id, request_id);
    ";

    async fn memory_driver() -> SqlDriver {
        let driver = SqlDriver::open_sqlite(":memory:").unwrap();
        driver.exec(DDL).await.unwrap();
        driver
    }

    /// A `MessageSent` payload (field insertion order = packed field order).
    fn message_payload(body: &str) -> Value {
        Value::Map(vec![
            ("messageId".into(), Value::from(format!("m-{body}"))),
            ("senderId".into(), Value::from("user-ada")),
            ("body".into(), Value::from(body)),
            ("createdAt".into(), Value::from("2026-05-31T00:00:00.000Z")),
        ])
    }

    fn body_of(stored: &StoredEvent) -> String {
        let Value::Map(entries) = &stored.event.payload else {
            panic!("payload is not a map");
        };
        for (key, value) in entries {
            if key.as_str() == Some("body") {
                return value.as_str().unwrap().to_string();
            }
        }
        panic!("payload has no body");
    }

    /// Append a `MessageSent` with a deterministic event id and request id.
    #[allow(clippy::too_many_arguments)]
    async fn append_msg(
        store: &StreamStore<'_>,
        stream_id: &str,
        body: &str,
        app_id: &str,
    ) -> AppendResult {
        store
            .append(
                TENANT,
                STREAM,
                stream_id,
                "r1",
                &format!("{app_id}-{stream_id}-{body}"),
                EVENT,
                &message_payload(body),
                app_id,
                &format!("event-{app_id}-{stream_id}-{body}"),
                NOW,
                None,
            )
            .await
            .unwrap()
    }

    async fn count(store: &StreamStore<'_>, stream_id: &str) -> usize {
        store
            .read(TENANT, STREAM, stream_id, 0, None, DEFAULT_APP_ID)
            .await
            .unwrap()
            .len()
    }

    // ── ISO parse round-trip (Date.parse ∘ toISOString) ─────────────────────

    #[test]
    fn parse_iso_ms_round_trips_iso_from_epoch_ms() {
        for ms in [
            0_i64,
            1,
            999,
            1_700_000_000_123,
            951_827_696_789,
            4_102_444_799_999,
            1_456_704_000_000,
        ] {
            assert_eq!(
                parse_iso_ms_opt(&iso_from_epoch_ms(ms)),
                Some(ms),
                "round-trip failed for {ms}"
            );
        }
        // Negative epochs (pre-1970) also round-trip.
        assert_eq!(parse_iso_ms_opt(&iso_from_epoch_ms(-1)), Some(-1));
    }

    #[test]
    fn parse_iso_ms_is_nan_for_unparseable() {
        assert!(parse_iso_ms("not-a-date").is_nan());
        assert!(parse_iso_ms("").is_nan());
        // Right length, wrong separators.
        assert!(parse_iso_ms("2026/05/31 00:00:00.000Z").is_nan());
    }

    // ── append() basics ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn append_assigns_monotonic_sequences_and_returns_created() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, None);

        let a = append_msg(&store, "conv-a", "first", DEFAULT_APP_ID).await;
        let b = append_msg(&store, "conv-a", "second", DEFAULT_APP_ID).await;

        assert!(a.created);
        assert!(b.created);
        assert_eq!(a.event.event.sequence, 1);
        assert_eq!(b.event.event.sequence, 2);
        assert_eq!(a.event.event.event_id, "event-_default-conv-a-first");
        assert_eq!(a.event.app_id, DEFAULT_APP_ID);
        assert_eq!(a.event.tenant_id, TENANT);
        assert_eq!(body_of(&a.event), "first");
    }

    /// A replay of the same (app, tenant, replica, request) dedupes to the same
    /// event and reports `created: false`.
    #[tokio::test]
    async fn append_dedups_replays_by_request_id() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, None);

        let first = store
            .append(
                TENANT,
                STREAM,
                "room-1",
                "r-1",
                "req-1",
                EVENT,
                &message_payload("a"),
                DEFAULT_APP_ID,
                "event-1",
                NOW,
                None,
            )
            .await
            .unwrap();
        assert!(first.created);

        // Same request id, even with a different event id, returns the first
        // event (durable idempotency row).
        let replay = store
            .append(
                TENANT,
                STREAM,
                "room-1",
                "r-1",
                "req-1",
                EVENT,
                &message_payload("a"),
                DEFAULT_APP_ID,
                "event-2",
                NOW,
                None,
            )
            .await
            .unwrap();
        assert!(!replay.created);
        assert_eq!(replay.event.event.event_id, "event-1");
        assert_eq!(replay.event.event.sequence, 1);

        // Only one event landed.
        assert_eq!(count(&store, "room-1").await, 1);
    }

    /// The front-cache short-circuits the durable lookup but yields the same
    /// dedup result.
    #[tokio::test]
    async fn append_dedups_via_front_cache() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, None);
        let mut cache = BoundedIdempotencyCache::new(16.0).unwrap();

        let first = store
            .append(
                TENANT,
                STREAM,
                "room-1",
                "r-1",
                "req-1",
                EVENT,
                &message_payload("a"),
                DEFAULT_APP_ID,
                "event-1",
                NOW,
                Some(&mut cache),
            )
            .await
            .unwrap();
        assert!(first.created);
        assert_eq!(cache.size(), 1);

        let replay = store
            .append(
                TENANT,
                STREAM,
                "room-1",
                "r-1",
                "req-1",
                EVENT,
                &message_payload("a"),
                DEFAULT_APP_ID,
                "event-2",
                NOW,
                Some(&mut cache),
            )
            .await
            .unwrap();
        assert!(!replay.created);
        assert_eq!(replay.event.event.event_id, "event-1");
        assert_eq!(count(&store, "room-1").await, 1);
    }

    /// Outside the replay window a durable row is treated as not-seen, so a
    /// fresh event is minted and the stale idempotency row is rewritten (upsert).
    #[tokio::test]
    async fn append_beyond_replay_window_mints_a_fresh_event() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let day_ms = 24 * 60 * 60 * 1000;
        let store = StreamStore::new(&driver, &schema, Some(day_ms));

        let first = store
            .append(
                TENANT,
                STREAM,
                "room-1",
                "r-1",
                "req-1",
                EVENT,
                &message_payload("a"),
                DEFAULT_APP_ID,
                "event-1",
                NOW,
                None,
            )
            .await
            .unwrap();
        assert!(first.created);

        // Two days later the row is beyond the 1-day window → not-seen.
        let later = NOW + 2 * day_ms;
        let again = store
            .append(
                TENANT,
                STREAM,
                "room-1",
                "r-1",
                "req-1",
                EVENT,
                &message_payload("a"),
                DEFAULT_APP_ID,
                "event-2",
                later,
                None,
            )
            .await
            .unwrap();
        assert!(again.created);
        assert_eq!(again.event.event.event_id, "event-2");
        assert_eq!(again.event.event.sequence, 2);

        // The idempotency row was upserted (not duplicated): a within-window
        // replay now dedupes to the fresh event.
        let replay = store
            .append(
                TENANT,
                STREAM,
                "room-1",
                "r-1",
                "req-1",
                EVENT,
                &message_payload("a"),
                DEFAULT_APP_ID,
                "event-3",
                later,
                None,
            )
            .await
            .unwrap();
        assert!(!replay.created);
        assert_eq!(replay.event.event.event_id, "event-2");
    }

    /// An unparseable durable `created_at` fails closed (treated as not-seen)
    /// once a replay window is configured.
    #[tokio::test]
    async fn append_fails_closed_on_unparseable_created_at() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, Some(60_000));

        let first = store
            .append(
                TENANT,
                STREAM,
                "room-1",
                "r-1",
                "req-1",
                EVENT,
                &message_payload("a"),
                DEFAULT_APP_ID,
                "event-1",
                NOW,
                None,
            )
            .await
            .unwrap();
        assert!(first.created);

        // Corrupt the durable created_at so it can't be parsed.
        driver
            .run(
                "UPDATE idempotency_keys SET created_at = ? WHERE request_id = ?",
                &["not-a-timestamp".into(), "req-1".into()],
            )
            .await
            .unwrap();

        let again = store
            .append(
                TENANT,
                STREAM,
                "room-1",
                "r-1",
                "req-1",
                EVENT,
                &message_payload("a"),
                DEFAULT_APP_ID,
                "event-2",
                NOW,
                None,
            )
            .await
            .unwrap();
        assert!(again.created, "unparseable timestamp must fail closed");
        assert_eq!(again.event.event.event_id, "event-2");
    }

    // ── per-app scoping (port of app-scoping.test.ts StreamStore block) ──────

    /// "isolates stream reads: app B cannot read app A's events".
    #[tokio::test]
    async fn isolates_stream_reads_across_apps() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, None);

        append_msg(&store, "room-1", "from-a", "app-a").await;

        assert_eq!(
            store
                .read(TENANT, STREAM, "room-1", 0, None, "app-a")
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .read(TENANT, STREAM, "room-1", 0, None, "app-b")
                .await
                .unwrap()
                .len(),
            0
        );
        // Default app sees nothing either.
        assert_eq!(count(&store, "room-1").await, 0);
    }

    /// "stamps appId on stored events; sequence is shared across the stream PK".
    #[tokio::test]
    async fn stamps_app_id_and_shares_sequence_space() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, None);

        let a1 = append_msg(&store, "room-1", "a1", "app-a").await;
        let a2 = append_msg(&store, "room-1", "a2", "app-a").await;
        let b1 = append_msg(&store, "room-1", "b1", "app-b").await;

        assert_eq!(a1.event.app_id, "app-a");
        assert_eq!(a1.event.event.sequence, 1);
        assert_eq!(a2.event.event.sequence, 2);
        // PK excludes app_id → app-b takes the next global sequence (3).
        assert_eq!(b1.event.app_id, "app-b");
        assert_eq!(b1.event.event.sequence, 3);

        assert_eq!(
            store
                .read(TENANT, STREAM, "room-1", 0, None, "app-a")
                .await
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            store
                .read(TENANT, STREAM, "room-1", 0, None, "app-b")
                .await
                .unwrap()
                .len(),
            1
        );
    }

    /// "stamps app_id on the idempotency row and dedups replays within an app".
    #[tokio::test]
    async fn stamps_app_id_on_idempotency_row_and_dedups_within_app() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, None);

        let a = store
            .append(
                TENANT,
                STREAM,
                "room-1",
                "r-1",
                "req-1",
                EVENT,
                &message_payload("a"),
                "app-a",
                "event-a",
                NOW,
                None,
            )
            .await
            .unwrap();
        assert!(a.created);
        assert_eq!(a.event.app_id, "app-a");

        let replay = store
            .append(
                TENANT,
                STREAM,
                "room-1",
                "r-1",
                "req-1",
                EVENT,
                &message_payload("a"),
                "app-a",
                "event-a2",
                NOW,
                None,
            )
            .await
            .unwrap();
        assert!(!replay.created);
        assert_eq!(replay.event.event.event_id, a.event.event.event_id);

        let row = driver
            .get(
                "SELECT app_id FROM idempotency_keys WHERE tenant_id = ? AND replica_id = ? AND request_id = ?",
                &[TENANT.into(), "r-1".into(), "req-1".into()],
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.text("app_id"), Some("app-a"));
    }

    /// "listAll / head are app-scoped".
    #[tokio::test]
    async fn list_all_and_head_are_app_scoped() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, None);

        append_msg(&store, "room-1", "a1", "app-a").await;
        append_msg(&store, "room-1", "b1", "app-b").await;

        assert_eq!(store.list_all(TENANT, "app-a").await.unwrap().len(), 1);
        assert_eq!(store.list_all(TENANT, "app-b").await.unwrap().len(), 1);

        assert_eq!(
            store
                .head(TENANT, STREAM, "room-1", "app-a")
                .await
                .unwrap()
                .count,
            1
        );
        assert_eq!(
            store
                .head(TENANT, STREAM, "room-1", "app-b")
                .await
                .unwrap()
                .count,
            1
        );
        // Default app: empty.
        assert_eq!(
            store
                .head(TENANT, STREAM, "room-1", DEFAULT_APP_ID)
                .await
                .unwrap()
                .count,
            0
        );
    }

    // ── reads: head / read / read_before / list_all_by_stream_type ──────────

    #[tokio::test]
    async fn head_reports_max_sequence_and_count() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, None);

        for body in ["a", "b", "c", "d", "e"] {
            append_msg(&store, "conv1", body, DEFAULT_APP_ID).await;
        }
        let head = store
            .head(TENANT, STREAM, "conv1", DEFAULT_APP_ID)
            .await
            .unwrap();
        assert_eq!(head.head_sequence, 5);
        assert_eq!(head.count, 5);

        // Empty/unknown stream.
        let empty = store
            .head(TENANT, STREAM, "never", DEFAULT_APP_ID)
            .await
            .unwrap();
        assert_eq!(empty.head_sequence, 0);
        assert_eq!(empty.count, 0);
    }

    #[tokio::test]
    async fn read_after_cursor_ascending_with_limit() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, None);

        for body in ["a", "b", "c", "d", "e"] {
            append_msg(&store, "conv2", body, DEFAULT_APP_ID).await;
        }

        // since=2 → c, d, e ascending.
        let after = store
            .read(TENANT, STREAM, "conv2", 2, None, DEFAULT_APP_ID)
            .await
            .unwrap();
        assert_eq!(
            after.iter().map(body_of).collect::<Vec<_>>(),
            vec!["c", "d", "e"]
        );

        // since=1 limit=2 → b, c.
        let limited = store
            .read(TENANT, STREAM, "conv2", 1, Some(2), DEFAULT_APP_ID)
            .await
            .unwrap();
        assert_eq!(
            limited.iter().map(body_of).collect::<Vec<_>>(),
            vec!["b", "c"]
        );

        // since at the head → empty.
        let at_head = store
            .read(TENANT, STREAM, "conv2", 5, None, DEFAULT_APP_ID)
            .await
            .unwrap();
        assert!(at_head.is_empty());

        // A non-positive limit clamps to 1.
        let clamped = store
            .read(TENANT, STREAM, "conv2", 0, Some(0), DEFAULT_APP_ID)
            .await
            .unwrap();
        assert_eq!(clamped.iter().map(body_of).collect::<Vec<_>>(), vec!["a"]);
    }

    #[tokio::test]
    async fn read_before_is_oldest_first_and_clamped() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, None);

        for body in ["a", "b", "c", "d", "e"] {
            append_msg(&store, "conv3", body, DEFAULT_APP_ID).await;
        }

        // before=4 → sequences 1..=3 (a,b,c), oldest-first.
        let before = store
            .read_before(TENANT, STREAM, "conv3", 4, 100, DEFAULT_APP_ID)
            .await
            .unwrap();
        assert_eq!(
            before.iter().map(body_of).collect::<Vec<_>>(),
            vec!["a", "b", "c"]
        );

        // limit clamps the page: before=6, limit=2 → the two NEWEST below 6
        // (d, e), still oldest-first.
        let page = store
            .read_before(TENANT, STREAM, "conv3", 6, 2, DEFAULT_APP_ID)
            .await
            .unwrap();
        assert_eq!(page.iter().map(body_of).collect::<Vec<_>>(), vec!["d", "e"]);

        // before <= 0 uses the MAX_SAFE_INTEGER sentinel → all events.
        let all = store
            .read_before(TENANT, STREAM, "conv3", 0, 500, DEFAULT_APP_ID)
            .await
            .unwrap();
        assert_eq!(all.len(), 5);
    }

    #[tokio::test]
    async fn list_all_by_stream_type_spans_stream_ids() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, None);

        append_msg(&store, "conv-a", "a1", DEFAULT_APP_ID).await;
        append_msg(&store, "conv-b", "b1", DEFAULT_APP_ID).await;
        append_msg(&store, "conv-a", "a2", DEFAULT_APP_ID).await;

        let all = store
            .list_all_by_stream_type(TENANT, STREAM, DEFAULT_APP_ID)
            .await
            .unwrap();
        // Ordered by (stream_id, sequence): conv-a/a1, conv-a/a2, conv-b/b1.
        assert_eq!(
            all.iter().map(body_of).collect::<Vec<_>>(),
            vec!["a1", "a2", "b1"]
        );
    }

    // ── pruneRetention (port of stream-retention.test.ts) ───────────────────

    /// Append N events to a stream id, each with a distinct request id.
    async fn append_n(store: &StreamStore<'_>, stream_id: &str, n: usize) {
        for i in 0..n {
            store
                .append(
                    TENANT,
                    STREAM,
                    stream_id,
                    "r1",
                    &format!("{stream_id}-{i}"),
                    EVENT,
                    &message_payload(&format!("body {i}")),
                    DEFAULT_APP_ID,
                    &format!("event-{stream_id}-{i}"),
                    NOW,
                    None,
                )
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn prune_keeps_full_history_with_no_policy() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, None);
        append_n(&store, "conv-a", 5).await;

        let result = store.prune_retention(&[], NOW).await.unwrap();
        assert_eq!(result, StreamRetentionPruneResult::default());
        assert_eq!(count(&store, "conv-a").await, 5);
    }

    #[tokio::test]
    async fn prune_keeps_newest_max_events_per_stream_id() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, None);
        append_n(&store, "conv-a", 10).await;
        append_n(&store, "conv-b", 3).await;

        let policy = StreamRetentionPolicy {
            max_events: Some(4),
            ..StreamRetentionPolicy::default()
        };
        let result = store
            .prune_retention(&[(STREAM, policy)], NOW)
            .await
            .unwrap();
        // conv-a: 10 → 4 (6 removed); conv-b: 3 ≤ 4 (none).
        assert_eq!(result.pruned_by_count, 6);
        assert_eq!(count(&store, "conv-a").await, 4);
        assert_eq!(count(&store, "conv-b").await, 3);

        // The survivors are the NEWEST events (highest sequences).
        let remaining = store
            .read(TENANT, STREAM, "conv-a", 0, None, DEFAULT_APP_ID)
            .await
            .unwrap();
        assert_eq!(
            remaining.iter().map(body_of).collect::<Vec<_>>(),
            vec!["body 6", "body 7", "body 8", "body 9"]
        );
    }

    #[tokio::test]
    async fn prune_drops_events_older_than_max_age_and_is_idempotent() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, None);
        // Append stamps created_at with NOW.
        append_n(&store, "conv-a", 5).await;
        let day = 24 * 60 * 60 * 1000;

        // A huge maxAgeMs evaluated at NOW prunes nothing.
        let keep_policy = StreamRetentionPolicy {
            max_age_ms: Some(365 * day),
            ..StreamRetentionPolicy::default()
        };
        let keep = store
            .prune_retention(&[(STREAM, keep_policy)], NOW)
            .await
            .unwrap();
        assert_eq!(keep.pruned_by_age, 0);
        assert_eq!(count(&store, "conv-a").await, 5);

        // Evaluate "10 days later" with a 1-day window: every row is older than
        // the cutoff, so all are pruned.
        let ten_days_later = NOW + 10 * day;
        let prune_policy = StreamRetentionPolicy {
            max_age_ms: Some(day),
            ..StreamRetentionPolicy::default()
        };
        let pruned = store
            .prune_retention(&[(STREAM, prune_policy.clone())], ten_days_later)
            .await
            .unwrap();
        assert_eq!(pruned.pruned_by_age, 5);
        assert_eq!(count(&store, "conv-a").await, 0);

        // Idempotent: nothing left to prune.
        let again = store
            .prune_retention(&[(STREAM, prune_policy)], ten_days_later)
            .await
            .unwrap();
        assert_eq!(again.pruned_by_age, 0);
    }

    #[tokio::test]
    async fn prune_only_touches_the_named_stream_type() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, None);
        append_n(&store, "conv-a", 6).await;

        let policy = StreamRetentionPolicy {
            max_events: Some(1),
            ..StreamRetentionPolicy::default()
        };
        let result = store
            .prune_retention(&[("SomeOtherStream", policy)], NOW)
            .await
            .unwrap();
        assert_eq!(result.pruned_by_count, 0);
        assert_eq!(count(&store, "conv-a").await, 6);
    }

    #[tokio::test]
    async fn prune_scopes_to_tenant_and_app_when_set() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, None);

        // Two apps share the same (tenant, stream, streamId) sequence space.
        append_msg(&store, "room-1", "a1", "app-a").await;
        append_msg(&store, "room-1", "a2", "app-a").await;
        append_msg(&store, "room-1", "b1", "app-b").await;

        // An app-scoped maxEvents:0 prunes only app-a's rows.
        let policy = StreamRetentionPolicy {
            max_events: Some(0),
            app_id: Some("app-a".into()),
            ..StreamRetentionPolicy::default()
        };
        let result = store
            .prune_retention(&[(STREAM, policy)], NOW)
            .await
            .unwrap();
        assert_eq!(result.pruned_by_count, 2);
        assert_eq!(
            store
                .read(TENANT, STREAM, "room-1", 0, None, "app-a")
                .await
                .unwrap()
                .len(),
            0
        );
        // app-b is untouched.
        assert_eq!(
            store
                .read(TENANT, STREAM, "room-1", 0, None, "app-b")
                .await
                .unwrap()
                .len(),
            1
        );
    }

    /// Unknown event names surface the TS codec error message verbatim.
    #[tokio::test]
    async fn append_unknown_event_matches_ts_error() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, None);

        let error = store
            .append(
                TENANT,
                STREAM,
                "room-1",
                "r-1",
                "req-1",
                "Nope",
                &message_payload("a"),
                DEFAULT_APP_ID,
                "event-1",
                NOW,
                None,
            )
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "Unknown event: Nope");
    }

    // ── redact_event / redact_by_field (AURA-191) ───────────────────────────

    /// Redacting an event zeroes its payload but leaves its identity —
    /// sequence, event id, ordering relative to its neighbours — completely
    /// intact, so a stream reader sees no gap and no renumbering.
    #[tokio::test]
    async fn redact_event_clears_payload_but_preserves_sequence_and_event_id() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, None);

        for body in ["a", "b", "c"] {
            append_msg(&store, "conv-a", body, DEFAULT_APP_ID).await;
        }

        let redacted = store
            .redact_event(TENANT, STREAM, "conv-a", 2, DEFAULT_APP_ID)
            .await
            .unwrap();
        assert!(redacted);

        let all = store
            .read(TENANT, STREAM, "conv-a", 0, None, DEFAULT_APP_ID)
            .await
            .unwrap();
        assert_eq!(all.len(), 3, "redaction must not delete or gap the row");
        assert_eq!(all[0].event.sequence, 1);
        assert_eq!(all[1].event.sequence, 2);
        assert_eq!(all[2].event.sequence, 3);
        assert_eq!(all[1].event.event_id, "event-_default-conv-a-b");
        assert_eq!(all[1].event.event, EVENT, "event type identity survives");

        // The payload is gone (empty map) — no residual plaintext.
        let Value::Map(entries) = &all[1].event.payload else {
            panic!("expected map");
        };
        assert!(
            entries.is_empty(),
            "redacted payload must carry no fields, got {entries:?}"
        );

        // Neighbours are untouched.
        assert_eq!(body_of(&all[0]), "a");
        assert_eq!(body_of(&all[2]), "c");

        // The SQL event_type column is stamped with the audit marker, while
        // the packed tuple's own identity is what readers actually decode.
        let row = driver
            .get(
                "SELECT event_type FROM stream_events WHERE stream_id = ? AND sequence = ?",
                &["conv-a".into(), 2_i64.into()],
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.text("event_type"), Some(REDACTED_EVENT_TYPE_MARKER));
    }

    /// Redacting an address with no row is a no-op, not an error.
    #[tokio::test]
    async fn redact_event_is_noop_for_missing_row() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, None);

        let redacted = store
            .redact_event(TENANT, STREAM, "never", 1, DEFAULT_APP_ID)
            .await
            .unwrap();
        assert!(!redacted);
    }

    /// Redacting twice is idempotent: the second call is a normal update (the
    /// row still exists) and the payload stays empty.
    #[tokio::test]
    async fn redact_event_is_idempotent() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, None);
        append_msg(&store, "conv-a", "a", DEFAULT_APP_ID).await;

        assert!(
            store
                .redact_event(TENANT, STREAM, "conv-a", 1, DEFAULT_APP_ID)
                .await
                .unwrap()
        );
        assert!(
            store
                .redact_event(TENANT, STREAM, "conv-a", 1, DEFAULT_APP_ID)
                .await
                .unwrap()
        );

        assert_eq!(count(&store, "conv-a").await, 1);
    }

    /// Redaction is scoped by app: even though the PK excludes `app_id` (the
    /// sequence space is shared, so `app-a`'s row lands at sequence 1 and
    /// `app-b`'s at sequence 2), asking `app-b` to redact `app-a`'s row is a
    /// no-op, and asking `app-b` to redact its own row succeeds without
    /// touching `app-a`'s — mirroring `ObjectStore`'s cross-app isolation.
    #[tokio::test]
    async fn redact_event_isolates_by_app() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, None);

        let a1 = append_msg(&store, "room-1", "a1", "app-a").await;
        let b1 = append_msg(&store, "room-1", "b1", "app-b").await;
        assert_eq!(a1.event.event.sequence, 1);
        assert_eq!(b1.event.event.sequence, 2);

        // app-b cannot redact app-a's row by guessing its sequence.
        let cross_app = store
            .redact_event(TENANT, STREAM, "room-1", 1, "app-b")
            .await
            .unwrap();
        assert!(!cross_app);
        let a_events = store
            .read(TENANT, STREAM, "room-1", 0, None, "app-a")
            .await
            .unwrap();
        assert_eq!(body_of(&a_events[0]), "a1", "app-a's row is untouched");

        // app-b redacting its own row succeeds and leaves app-a alone.
        let own = store
            .redact_event(TENANT, STREAM, "room-1", 2, "app-b")
            .await
            .unwrap();
        assert!(own);
        let a_events_after = store
            .read(TENANT, STREAM, "room-1", 0, None, "app-a")
            .await
            .unwrap();
        assert_eq!(body_of(&a_events_after[0]), "a1");
    }

    /// `redact_by_field` finds every event whose payload field matches and
    /// redacts each one, leaving non-matching events and their sequences
    /// alone — the enumeration step an account-deletion cascade needs to
    /// erase a user's authored content from a stream shared with others.
    #[tokio::test]
    async fn redact_by_field_redacts_only_matching_events() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, None);

        // Two senders' messages interleaved in the same conversation stream.
        let payload_for = |sender: &str, body: &str| {
            Value::Map(vec![
                ("messageId".into(), Value::from(format!("m-{body}"))),
                ("senderId".into(), Value::from(sender)),
                ("body".into(), Value::from(body)),
                ("createdAt".into(), Value::from("2026-05-31T00:00:00.000Z")),
            ])
        };
        for (i, (sender, body)) in [
            ("user-ada", "hi"),
            ("user-bob", "hello"),
            ("user-ada", "bye"),
        ]
        .iter()
        .enumerate()
        {
            store
                .append(
                    TENANT,
                    STREAM,
                    "conv-shared",
                    "r1",
                    &format!("req-{i}"),
                    EVENT,
                    &payload_for(sender, body),
                    DEFAULT_APP_ID,
                    &format!("event-{i}"),
                    NOW,
                    None,
                )
                .await
                .unwrap();
        }

        let redacted = store
            .redact_by_field(TENANT, STREAM, DEFAULT_APP_ID, "senderId", "user-ada")
            .await
            .unwrap();
        assert_eq!(redacted, 2);

        let all = store
            .read(TENANT, STREAM, "conv-shared", 0, None, DEFAULT_APP_ID)
            .await
            .unwrap();
        assert_eq!(all.len(), 3, "no rows are deleted, only redacted");
        assert_eq!(all[0].event.sequence, 1);
        assert_eq!(all[1].event.sequence, 2);
        assert_eq!(all[2].event.sequence, 3);

        // user-ada's two messages are hollowed out.
        for stored in [&all[0], &all[2]] {
            let Value::Map(entries) = &stored.event.payload else {
                panic!("expected map");
            };
            assert!(entries.is_empty());
        }
        // user-bob's message survives untouched.
        assert_eq!(body_of(&all[1]), "hello");
    }

    /// No matches ⇒ `0`, and it's not an error.
    #[tokio::test]
    async fn redact_by_field_returns_zero_when_nothing_matches() {
        let driver = memory_driver().await;
        let schema = test_schema();
        let store = StreamStore::new(&driver, &schema, None);
        append_msg(&store, "conv-a", "a", DEFAULT_APP_ID).await;

        let redacted = store
            .redact_by_field(TENANT, STREAM, DEFAULT_APP_ID, "senderId", "nobody")
            .await
            .unwrap();
        assert_eq!(redacted, 0);
        assert_eq!(count(&store, "conv-a").await, 1);
    }
}
