//! Determinism seams for the [`FrickStore`](crate::facade::FrickStore) facade.
//!
//! The facade is the boundary where real wall-clock time and crypto-random
//! enter the store layer (map 03 §7, "Clock": the data-plane stores never read
//! the system clock — every `now_ms` and generated id is injected from here).
//! Production wires the [`SystemClock`] and [`OsIdGen`]; tests swap in a fixed
//! clock and a deterministic id generator so a `FrickStore` is fully
//! reproducible.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;

/// Wall-clock source, in epoch milliseconds. Mirrors the TS `Date.now()` calls
/// the facade makes (`created_at`, `expires_at`, prune cutoffs). The default
/// [`SystemClock`] reads the OS clock; tests inject a [`FixedClock`].
pub trait Clock: Send + Sync {
    /// Current time as epoch milliseconds.
    fn now_ms(&self) -> i64;
}

/// Production clock: the system time as epoch milliseconds.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        // Epoch-ms stays well inside i64 for any realistic clock; saturate
        // rather than panic on a pathologically far-future system clock.
        i64::try_from(millis).unwrap_or(i64::MAX)
    }
}

/// A fixed (or manually-advanced) clock for deterministic tests. Holds the
/// current epoch-ms behind a mutex so it can be advanced from `&self`.
#[derive(Debug)]
pub struct FixedClock {
    now_ms: Mutex<i64>,
}

impl FixedClock {
    /// Construct a clock pinned at `now_ms` epoch milliseconds.
    #[must_use]
    pub fn new(now_ms: i64) -> Self {
        Self {
            now_ms: Mutex::new(now_ms),
        }
    }

    /// Advance the clock by `delta_ms`. Saturates rather than panicking.
    pub fn advance(&self, delta_ms: i64) {
        if let Ok(mut now) = self.now_ms.lock() {
            *now = now.saturating_add(delta_ms);
        }
    }

    /// Set the clock to an absolute epoch-ms value.
    pub fn set(&self, now_ms: i64) {
        if let Ok(mut now) = self.now_ms.lock() {
            *now = now_ms;
        }
    }
}

impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.now_ms.lock().map_or(0, |now| *now)
    }
}

/// Identifier / token / salt generator. The facade hands these down to the
/// stores' injected params: stream `event_id`s (`"event-" + uuid`), random
/// tokens, password salts, etc. The default [`OsIdGen`] draws from the OS CSPRNG
/// and a v4 UUID; tests inject a [`SeededIdGen`] for reproducible ids.
pub trait IdGen: Send + Sync {
    /// A bare UUID (v4 in production) without any prefix.
    fn uuid(&self) -> String;

    /// `n` random bytes, base64url-encoded (no padding) — the TS
    /// `randomBytes(n).toString("base64url")` shape used for tokens and salts.
    fn random_base64url(&self, n: usize) -> String;

    /// A stream event id: `"event-" + uuid` (map 03 §15).
    fn event_id(&self) -> String {
        format!("event-{}", self.uuid())
    }
}

/// Production id generator: v4 UUIDs and OS-CSPRNG base64url tokens.
#[derive(Debug, Clone, Copy, Default)]
pub struct OsIdGen;

impl IdGen for OsIdGen {
    fn uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }

    fn random_base64url(&self, n: usize) -> String {
        let mut bytes = vec![0u8; n];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        URL_SAFE_NO_PAD.encode(bytes)
    }
}

/// A deterministic id generator for tests: a monotonic counter feeds both the
/// UUID-shaped ids and the "random" byte streams, so successive calls return
/// stable, distinct values.
#[derive(Debug, Default)]
pub struct SeededIdGen {
    counter: Mutex<u64>,
}

impl SeededIdGen {
    /// Construct a generator starting at counter `0`.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn next(&self) -> u64 {
        let mut counter = self
            .counter
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let value = *counter;
        *counter = counter.wrapping_add(1);
        value
    }
}

impl IdGen for SeededIdGen {
    fn uuid(&self) -> String {
        // A v4-shaped, stable, monotonically-distinct identifier.
        let n = self.next();
        format!("00000000-0000-4000-8000-{n:012x}")
    }

    fn random_base64url(&self, n: usize) -> String {
        let seed = self.next();
        let mut bytes = vec![0u8; n];
        for (index, byte) in bytes.iter_mut().enumerate() {
            // Stable byte fill derived from the counter + position.
            *byte = (seed.wrapping_add(index as u64) & 0xff) as u8;
        }
        URL_SAFE_NO_PAD.encode(bytes)
    }
}
