//! Bounded in-memory idempotency cache
//! (`apps/server/src/storage/idempotency-cache.ts`, map 03 §8.3).
//!
//! The durable source of truth for idempotency lookups is the
//! `idempotency_keys` table (see [`crate::stores::stream::StreamStore`]).
//! This is a classic LRU map keyed by a caller-defined string (typically
//! `appId|tenantId|replicaId|requestId`) and bounded by a configurable
//! capacity. When the capacity is exceeded, the least-recently-used entries
//! are dropped — those callers simply fall through to the SQL lookup on the
//! next access, so dropping a cache entry never breaks idempotency semantics.
//!
//! The cache is intentionally pure (no I/O, no async, no time-based
//! eviction). TS keeps recency in `Map` insertion order; here a monotonic
//! stamp per entry plus a `BTreeMap<stamp, key>` index plays that role.

use std::collections::{BTreeMap, HashMap};

use crate::error::StoreError;

/// `DEFAULT_IDEMPOTENCY_CACHE_CAPACITY` (`store.ts:55`) — the facade default
/// capacity for the idempotency front-cache.
pub const DEFAULT_IDEMPOTENCY_CACHE_CAPACITY: usize = 10_000;

/// `BoundedIdempotencyCache<V>` — pure LRU on insertion-order recency.
///
/// `get` refreshes recency, `set` re-inserts at the most-recent position and
/// evicts the oldest entries while the size exceeds the capacity, counting
/// `evictions`.
#[derive(Debug)]
pub struct BoundedIdempotencyCache<V> {
    capacity: usize,
    entries: HashMap<String, (u64, V)>,
    order: BTreeMap<u64, String>,
    next_stamp: u64,
    evictions: u64,
}

impl<V> BoundedIdempotencyCache<V> {
    /// TS constructor: capacity must be finite and `> 0` (checked before
    /// flooring, so a fractional capacity below 1 is accepted and floors to
    /// 0 — bug-compatible). The error message mirrors the TS `Error`.
    pub fn new(capacity: f64) -> Result<Self, StoreError> {
        if !capacity.is_finite() || capacity <= 0.0 {
            return Err(StoreError::store(format!(
                "BoundedIdempotencyCache capacity must be > 0, got {capacity}"
            )));
        }
        // Validated finite and positive above; float→int saturates on
        // overflow, mirroring the unbounded JS number.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let floored = capacity.floor() as usize;
        Ok(Self {
            capacity: floored,
            entries: HashMap::new(),
            order: BTreeMap::new(),
            next_stamp: 0,
            evictions: 0,
        })
    }

    #[must_use]
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    #[must_use]
    pub fn size(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn evictions(&self) -> u64 {
        self.evictions
    }

    /// Look up a key, refreshing its recency on a hit (TS re-inserts at the
    /// end of the `Map` iteration order). A miss leaves the cache untouched.
    pub fn get(&mut self, key: &str) -> Option<&V> {
        let stale = self.entries.get(key).map(|(stamp, _)| *stamp)?;
        let fresh = self.next_stamp;
        self.next_stamp += 1;
        self.order.remove(&stale);
        self.order.insert(fresh, key.to_owned());
        let entry = self.entries.get_mut(key)?;
        entry.0 = fresh;
        Some(&entry.1)
    }

    /// Insert or replace a key at the most-recent position (TS deletes first
    /// so the key moves to the end regardless of whether it existed), then
    /// evict the least-recently-used entries while over capacity.
    pub fn set(&mut self, key: impl Into<String>, value: V) {
        let key = key.into();
        if let Some((stale, _)) = self.entries.remove(&key) {
            self.order.remove(&stale);
        }
        let fresh = self.next_stamp;
        self.next_stamp += 1;
        self.order.insert(fresh, key.clone());
        self.entries.insert(key, (fresh, value));
        while self.entries.len() > self.capacity {
            let Some((_, oldest)) = self.order.pop_first() else {
                break;
            };
            self.entries.remove(&oldest);
            self.evictions += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    //! Port of `apps/server/tests/idempotency-cache.test.ts`.

    use super::*;

    #[test]
    fn rejects_non_positive_capacity() {
        for capacity in [0.0, -1.0, f64::NAN] {
            let error = BoundedIdempotencyCache::<String>::new(capacity).unwrap_err();
            assert_eq!(
                error.to_string(),
                format!("BoundedIdempotencyCache capacity must be > 0, got {capacity}")
            );
        }
    }

    #[test]
    fn stores_entries_under_capacity_without_evicting() {
        let mut cache = BoundedIdempotencyCache::<i64>::new(3.0).unwrap();
        cache.set("a", 1);
        cache.set("b", 2);
        cache.set("c", 3);
        assert_eq!(cache.size(), 3);
        assert_eq!(cache.evictions(), 0);
        assert_eq!(cache.get("a"), Some(&1));
        assert_eq!(cache.get("b"), Some(&2));
        assert_eq!(cache.get("c"), Some(&3));
    }

    #[test]
    fn evicts_least_recently_used_keys_in_order_when_over_capacity() {
        let mut cache = BoundedIdempotencyCache::<i64>::new(2.0).unwrap();
        cache.set("a", 1);
        cache.set("b", 2);
        cache.set("c", 3); // evicts "a"
        assert_eq!(cache.size(), 2);
        assert_eq!(cache.evictions(), 1);
        assert_eq!(cache.get("a"), None);
        assert_eq!(cache.get("b"), Some(&2));
        assert_eq!(cache.get("c"), Some(&3));
    }

    #[test]
    fn updates_recency_on_get_so_oldest_becomes_newest_after_access() {
        let mut cache = BoundedIdempotencyCache::<i64>::new(3.0).unwrap();
        cache.set("a", 1);
        cache.set("b", 2);
        cache.set("c", 3);
        // Access "a" — it should now be most-recent.
        assert_eq!(cache.get("a"), Some(&1));
        cache.set("d", 4); // should evict "b" (now LRU), not "a"
        assert_eq!(cache.evictions(), 1);
        assert_eq!(cache.get("b"), None);
        assert_eq!(cache.get("a"), Some(&1));
        assert_eq!(cache.get("c"), Some(&3));
        assert_eq!(cache.get("d"), Some(&4));
    }

    #[test]
    fn re_setting_an_existing_key_updates_value_and_moves_it_to_most_recent() {
        let mut cache = BoundedIdempotencyCache::<i64>::new(3.0).unwrap();
        cache.set("a", 1);
        cache.set("b", 2);
        cache.set("c", 3);
        cache.set("a", 11); // update value, move to most-recent
        assert_eq!(cache.get("a"), Some(&11));
        cache.set("d", 4); // evicts "b" (now LRU)
        assert_eq!(cache.evictions(), 1);
        assert_eq!(cache.get("b"), None);
        assert_eq!(cache.get("a"), Some(&11));
        assert_eq!(cache.get("c"), Some(&3));
        assert_eq!(cache.get("d"), Some(&4));
    }

    #[test]
    fn increments_evictions_counter_on_each_eviction() {
        let mut cache = BoundedIdempotencyCache::<i64>::new(2.0).unwrap();
        cache.set("a", 1);
        cache.set("b", 2);
        assert_eq!(cache.evictions(), 0);
        cache.set("c", 3);
        assert_eq!(cache.evictions(), 1);
        cache.set("d", 4);
        assert_eq!(cache.evictions(), 2);
        cache.set("e", 5);
        assert_eq!(cache.evictions(), 3);
        assert_eq!(cache.size(), 2);
    }

    #[test]
    fn get_on_missing_key_returns_none_without_affecting_state() {
        let mut cache = BoundedIdempotencyCache::<i64>::new(2.0).unwrap();
        cache.set("a", 1);
        cache.set("b", 2);
        assert_eq!(cache.get("missing"), None);
        assert_eq!(cache.size(), 2);
        assert_eq!(cache.evictions(), 0);
    }

    #[test]
    fn default_capacity_matches_the_facade_constant() {
        let cache = BoundedIdempotencyCache::<i64>::new(10_000.0).unwrap();
        assert_eq!(cache.capacity(), DEFAULT_IDEMPOTENCY_CACHE_CAPACITY);
    }
}
