//! Blob-bytes storage seam (`apps/server/src/storage/blob-bytes-driver.ts`,
//! FR-53/FR-54). Blob *metadata* always lives in SQL (`blob_metadata`); the
//! raw *bytes* are served by a selectable driver:
//!
//! - [`SqlBlobBytesDriver`] (default) — bytes in the `blob_content` table via
//!   the [`SqlDriver`] seam, byte-for-byte the historical behavior.
//! - [`FilesystemBlobBytesDriver`] — bytes under a configured root in
//!   tenant-isolated, content-addressed files. Path layout and
//!   [`encode_segment`] are **byte-identical** to the TS driver (lines
//!   234–247 and 557–565), so a Rust server can read a TS server's blob tree.
//! - [`S3BlobBytesDriver`] — seam reserved; every call returns
//!   `StoreError::Store("s3 blob bytes driver not yet ported (FR-241
//!   follow-up)")` until the S3 port lands.
//!
//! Every method is `(app, tenant, blob)`-scoped. A driver MUST NOT let one
//! tenant (or app) read, write, or delete another's bytes — the filesystem
//! driver enforces this structurally by deriving every path segment from a
//! content-addressed encoding of the identifiers.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest, Sha256};

use crate::driver::SqlDriver;
use crate::error::StoreError;

/// `DEFAULT_APP_ID` (`apps/server/src/app-id.ts:37`): the app partition used
/// when a caller does not opt into multi-app namespacing.
pub const DEFAULT_APP_ID: &str = "_default";

/// `FrickBlobDriver` (`blob-bytes-driver.ts:38`): the driver selector, env
/// `FRICK_BLOB_DRIVER`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrickBlobDriver {
    Sqlite,
    Filesystem,
    S3,
}

/// The pluggable bytes driver. An enum rather than a trait so the store can
/// own it without boxing; mirrors the TS `BlobBytesDriver` interface
/// (`write`/`read`/`delete`/`exists`).
pub enum BlobBytesDriver {
    Sql(SqlBlobBytesDriver),
    Filesystem(FilesystemBlobBytesDriver),
    S3(S3BlobBytesDriver),
}

impl std::fmt::Debug for BlobBytesDriver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sql(_) => f.write_str("BlobBytesDriver::Sql"),
            Self::Filesystem(driver) => f
                .debug_tuple("BlobBytesDriver::Filesystem")
                .field(driver)
                .finish(),
            Self::S3(_) => f.write_str("BlobBytesDriver::S3"),
        }
    }
}

impl BlobBytesDriver {
    /// Persist (or overwrite) the bytes for `(app_id, tenant_id, blob_id)`.
    /// `now_ms` stamps `blob_content.updated_at` on the SQL arm (the TS driver
    /// calls `new Date().toISOString()`; system time stays at the facade).
    pub async fn write(
        &self,
        tenant_id: &str,
        blob_id: &str,
        content: &[u8],
        app_id: &str,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        match self {
            Self::Sql(driver) => {
                driver
                    .write(tenant_id, blob_id, content, app_id, now_ms)
                    .await
            }
            Self::Filesystem(driver) => driver.write(tenant_id, blob_id, content, app_id),
            Self::S3(driver) => driver.write(tenant_id, blob_id, content, app_id),
        }
    }

    /// Read the bytes for `(app_id, tenant_id, blob_id)`, or `None` if absent.
    pub async fn read(
        &self,
        tenant_id: &str,
        blob_id: &str,
        app_id: &str,
    ) -> Result<Option<Vec<u8>>, StoreError> {
        match self {
            Self::Sql(driver) => driver.read(tenant_id, blob_id, app_id).await,
            Self::Filesystem(driver) => driver.read(tenant_id, blob_id, app_id),
            Self::S3(driver) => driver.read(tenant_id, blob_id, app_id),
        }
    }

    /// Delete the bytes for `(app_id, tenant_id, blob_id)`. No-op when absent.
    pub async fn delete(
        &self,
        tenant_id: &str,
        blob_id: &str,
        app_id: &str,
    ) -> Result<(), StoreError> {
        match self {
            Self::Sql(driver) => driver.delete(tenant_id, blob_id, app_id).await,
            Self::Filesystem(driver) => driver.delete(tenant_id, blob_id, app_id),
            Self::S3(driver) => driver.delete(tenant_id, blob_id, app_id),
        }
    }

    /// Whether bytes exist for `(app_id, tenant_id, blob_id)`.
    pub async fn exists(
        &self,
        tenant_id: &str,
        blob_id: &str,
        app_id: &str,
    ) -> Result<bool, StoreError> {
        match self {
            Self::Sql(driver) => driver.exists(tenant_id, blob_id, app_id).await,
            Self::Filesystem(driver) => driver.exists(tenant_id, blob_id, app_id),
            Self::S3(driver) => driver.exists(tenant_id, blob_id, app_id),
        }
    }
}

/// Build the configured blob-bytes driver (`createBlobBytesDriver`,
/// `blob-bytes-driver.ts:259-293`). The filesystem driver requires a
/// non-empty storage path and validates it (creatable, writable directory) at
/// construction. The S3 selection returns the stub seam — the TS server
/// injects a pre-built SDK-backed driver here; the Rust port does not carry
/// it yet (FR-241 follow-up).
pub fn create_blob_bytes_driver(
    driver: FrickBlobDriver,
    db: &Arc<SqlDriver>,
    blob_storage_path: Option<&str>,
) -> Result<BlobBytesDriver, StoreError> {
    match driver {
        FrickBlobDriver::Filesystem => {
            let path = blob_storage_path.map_or("", str::trim);
            if path.is_empty() {
                return Err(StoreError::blob_storage(
                    "the filesystem blob driver requires FRICK_BLOB_STORAGE_PATH to be set to a writable directory",
                ));
            }
            Ok(BlobBytesDriver::Filesystem(FilesystemBlobBytesDriver::new(
                path,
            )?))
        }
        FrickBlobDriver::S3 => Ok(BlobBytesDriver::S3(S3BlobBytesDriver)),
        // Default: store bytes in `blob_content` via the seam — works on
        // SQLite (and the FR-242 Postgres arm) without a raw handle.
        FrickBlobDriver::Sqlite => Ok(BlobBytesDriver::Sql(SqlBlobBytesDriver::new(Arc::clone(
            db,
        )))),
    }
}

/// Default driver (`SqlBlobBytesDriver`, `blob-bytes-driver.ts:78-133`).
/// Stores blob bytes in the `blob_content` table via the async [`SqlDriver`],
/// so it is portable across dialects.
pub struct SqlBlobBytesDriver {
    sql: Arc<SqlDriver>,
}

impl SqlBlobBytesDriver {
    #[must_use]
    pub fn new(sql: Arc<SqlDriver>) -> Self {
        Self { sql }
    }

    pub async fn write(
        &self,
        tenant_id: &str,
        blob_id: &str,
        content: &[u8],
        app_id: &str,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        self.sql
            .run(
                "INSERT INTO blob_content (app_id, blob_id, content, updated_at, tenant_id)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT (blob_id) DO UPDATE SET
                      app_id = excluded.app_id,
                      content = excluded.content,
                      updated_at = excluded.updated_at,
                      tenant_id = excluded.tenant_id",
                &[
                    app_id.into(),
                    blob_id.into(),
                    content.to_vec().into(),
                    iso_from_epoch_ms(now_ms).into(),
                    tenant_id.into(),
                ],
            )
            .await?;
        Ok(())
    }

    pub async fn read(
        &self,
        tenant_id: &str,
        blob_id: &str,
        app_id: &str,
    ) -> Result<Option<Vec<u8>>, StoreError> {
        let row = self
            .sql
            .get(
                "SELECT content FROM blob_content WHERE app_id = ? AND tenant_id = ? AND blob_id = ?",
                &[app_id.into(), tenant_id.into(), blob_id.into()],
            )
            .await?;
        Ok(row.map(|row| row.blob("content").map(<[u8]>::to_vec).unwrap_or_default()))
    }

    pub async fn delete(
        &self,
        tenant_id: &str,
        blob_id: &str,
        app_id: &str,
    ) -> Result<(), StoreError> {
        self.sql
            .run(
                "DELETE FROM blob_content WHERE app_id = ? AND tenant_id = ? AND blob_id = ?",
                &[app_id.into(), tenant_id.into(), blob_id.into()],
            )
            .await?;
        Ok(())
    }

    pub async fn exists(
        &self,
        tenant_id: &str,
        blob_id: &str,
        app_id: &str,
    ) -> Result<bool, StoreError> {
        let row = self
            .sql
            .get(
                "SELECT 1 AS ok FROM blob_content WHERE app_id = ? AND tenant_id = ? AND blob_id = ?",
                &[app_id.into(), tenant_id.into(), blob_id.into()],
            )
            .await?;
        Ok(row.and_then(|row| row.i64("ok")) == Some(1))
    }
}

/// Process-wide counter for temp-file suffixes (the TS driver uses
/// `Math.random().toString(36).slice(2, 10)`; uniqueness — not randomness —
/// is the property the rename dance needs, so a pid + counter suffices).
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Filesystem driver (`FilesystemBlobBytesDriver`, `blob-bytes-driver.ts:158-248`).
/// Stores blob bytes under a configured root:
///
/// ```text
/// <root>/<tenantSegment>/<aa>/<blobSegment>                  (the _default app)
/// <root>/<appSegment>/<tenantSegment>/<aa>/<blobSegment>     (non-default apps)
/// ```
///
/// where the segments are [`encode_segment`] encodings and `<aa>` is the
/// two-char fan-out prefix of the blob segment. Because the path is a
/// deterministic function of the ids (never the raw ids), a crafted id
/// containing `/` or `..` can never escape its tenant directory.
#[derive(Debug, Clone)]
pub struct FilesystemBlobBytesDriver {
    root: PathBuf,
}

impl FilesystemBlobBytesDriver {
    /// Fail fast (FR-53): the configured root must be a creatable, writable
    /// directory, surfaced at construction so a misconfigured `filesystem`
    /// driver never starts the server in a half-broken state.
    pub fn new(root: &str) -> Result<Self, StoreError> {
        let resolved = std::path::absolute(root).map_err(|err| {
            StoreError::blob_storage(format!(
                "blob storage path is not creatable: {root} ({err})"
            ))
        })?;
        std::fs::create_dir_all(&resolved).map_err(|err| {
            StoreError::blob_storage(format!(
                "blob storage path is not creatable: {} ({err})",
                resolved.display()
            ))
        })?;
        assert_directory(&resolved)?;
        assert_writable(&resolved)?;
        Ok(Self { root: resolved })
    }

    pub fn write(
        &self,
        tenant_id: &str,
        blob_id: &str,
        content: &[u8],
        app_id: &str,
    ) -> Result<(), StoreError> {
        let target = self.path_for(tenant_id, blob_id, app_id);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|err| write_error(blob_id, &err))?;
        }
        // Write to a temp sibling then rename, so a concurrent reader never
        // observes a partially-written file and a crash mid-write leaves the
        // old bytes intact rather than a truncated file.
        let tmp = tmp_sibling(&target);
        let written = write_exclusive(&tmp, content).and_then(|()| std::fs::rename(&tmp, &target));
        if let Err(err) = written {
            // Best-effort cleanup of the temp file.
            let _ = std::fs::remove_file(&tmp);
            return Err(write_error(blob_id, &err));
        }
        Ok(())
    }

    pub fn read(
        &self,
        tenant_id: &str,
        blob_id: &str,
        app_id: &str,
    ) -> Result<Option<Vec<u8>>, StoreError> {
        match std::fs::read(self.path_for(tenant_id, blob_id, app_id)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(StoreError::blob_storage(format!(
                "failed to read blob bytes for {blob_id}: {err}"
            ))),
        }
    }

    pub fn delete(&self, tenant_id: &str, blob_id: &str, app_id: &str) -> Result<(), StoreError> {
        match std::fs::remove_file(self.path_for(tenant_id, blob_id, app_id)) {
            Ok(()) => Ok(()),
            // TS `rmSync(target, { force: true })`: absent is a no-op.
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(StoreError::blob_storage(format!(
                "failed to delete blob bytes for {blob_id}: {err}"
            ))),
        }
    }

    pub fn exists(&self, tenant_id: &str, blob_id: &str, app_id: &str) -> Result<bool, StoreError> {
        Ok(std::fs::metadata(self.path_for(tenant_id, blob_id, app_id)).is_ok())
    }

    /// Map `(app_id, tenant_id, blob_id)` to an absolute on-disk path —
    /// byte-identical to TS `#pathFor` (`blob-bytes-driver.ts:234-247`). The
    /// `_default` app keeps the historical `<root>/<tenant>/...` layout.
    fn path_for(&self, tenant_id: &str, blob_id: &str, app_id: &str) -> PathBuf {
        let tenant_segment = encode_segment(tenant_id);
        let blob_segment = encode_segment(blob_id);
        let fanout = &blob_segment[..2];
        if app_id == DEFAULT_APP_ID {
            self.root
                .join(tenant_segment)
                .join(fanout)
                .join(&blob_segment)
        } else {
            self.root
                .join(encode_segment(app_id))
                .join(tenant_segment)
                .join(fanout)
                .join(&blob_segment)
        }
    }
}

/// S3 bytes-driver seam (TS `S3BlobBytesDriver`, FR-54). The key layout is
/// `[prefix/][appSegment/]<tenantSegment>/<aa>/<blobSegment>` with the same
/// [`encode_segment`] encoding — NOT yet ported: every method returns
/// [`S3_BLOB_BYTES_STUB_MESSAGE`] so wiring it up is loud, not silent.
#[derive(Debug, Default, Clone, Copy)]
pub struct S3BlobBytesDriver;

/// The stub error message every [`S3BlobBytesDriver`] call returns.
pub const S3_BLOB_BYTES_STUB_MESSAGE: &str =
    "s3 blob bytes driver not yet ported (FR-241 follow-up)";

#[allow(clippy::unused_self)] // stub keeps the real driver's method shape
impl S3BlobBytesDriver {
    fn stub<T>() -> Result<T, StoreError> {
        Err(StoreError::store(S3_BLOB_BYTES_STUB_MESSAGE))
    }

    pub fn write(
        &self,
        _tenant_id: &str,
        _blob_id: &str,
        _content: &[u8],
        _app_id: &str,
    ) -> Result<(), StoreError> {
        Self::stub()
    }

    pub fn read(
        &self,
        _tenant_id: &str,
        _blob_id: &str,
        _app_id: &str,
    ) -> Result<Option<Vec<u8>>, StoreError> {
        Self::stub()
    }

    pub fn delete(
        &self,
        _tenant_id: &str,
        _blob_id: &str,
        _app_id: &str,
    ) -> Result<(), StoreError> {
        Self::stub()
    }

    pub fn exists(
        &self,
        _tenant_id: &str,
        _blob_id: &str,
        _app_id: &str,
    ) -> Result<bool, StoreError> {
        Self::stub()
    }
}

/// Deterministically encode an identifier into a filesystem-safe segment —
/// **byte-identical** to TS `encodeSegment` (`blob-bytes-driver.ts:557-565`):
///
/// ```text
/// hash     = hex(sha256(utf8(id)))[0..32]
/// readable = lowercase(id).replace(/[^a-z0-9_-]+/g, "-").trim('-').slice(0, 40)
/// segment  = readable ? "<readable>.<hash>" : hash
/// ```
///
/// The output alphabet is `[a-z0-9_-]` plus a single `.`, so a segment can
/// never contain `/` or `..` — traversal is structurally impossible.
#[must_use]
pub fn encode_segment(id: &str) -> String {
    let mut hash = hex::encode(Sha256::digest(id.as_bytes()));
    hash.truncate(32);
    let lowered = id.to_lowercase();
    let mut sanitized = String::with_capacity(lowered.len());
    let mut in_run = false;
    for ch in lowered.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-' {
            sanitized.push(ch);
            in_run = false;
        } else if !in_run {
            // A maximal run of disallowed chars collapses to a single '-'.
            sanitized.push('-');
            in_run = true;
        }
    }
    // Trim leading/trailing '-' FIRST, then bound to 40 chars (the TS order:
    // `.replace(/^-+|-+$/g, "").slice(0, 40)`), so a '-' at position 39 of
    // the trimmed string survives exactly like in TS.
    let trimmed = sanitized.trim_matches('-');
    let readable: String = trimmed.chars().take(40).collect();
    if readable.is_empty() {
        hash
    } else {
        format!("{readable}.{hash}")
    }
}

/// Format epoch milliseconds as `Date.prototype.toISOString()` does:
/// `YYYY-MM-DDTHH:mm:ss.sssZ` (lexicographic = chronological). Stores never
/// read the system clock — callers pass `now_ms` from the facade boundary.
pub(crate) fn iso_from_epoch_ms(epoch_ms: i64) -> String {
    let days = epoch_ms.div_euclid(86_400_000);
    let ms_of_day = epoch_ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let hour = ms_of_day / 3_600_000;
    let minute = ms_of_day % 3_600_000 / 60_000;
    let second = ms_of_day % 60_000 / 1_000;
    let millis = ms_of_day % 1_000;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Days-since-epoch → proleptic-Gregorian (year, month, day); Howard
/// Hinnant's `civil_from_days` algorithm.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn write_error(blob_id: &str, err: &std::io::Error) -> StoreError {
    StoreError::blob_storage(format!("failed to write blob bytes for {blob_id}: {err}"))
}

/// `<target>.<pid>.<suffix>.tmp` — a sibling so the rename stays on one
/// filesystem (TS: `${target}.${process.pid}.${randomSuffix()}.tmp`).
fn tmp_sibling(target: &Path) -> PathBuf {
    let suffix = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut name = target.as_os_str().to_os_string();
    name.push(format!(".{}.{suffix:08x}.tmp", std::process::id()));
    PathBuf::from(name)
}

/// Create-new write with mode `0o600` on unix (TS `writeFileSync(tmp, …,
/// { mode: 0o600 })`).
fn write_exclusive(path: &Path, content: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(content)
}

fn assert_directory(dir: &Path) -> Result<(), StoreError> {
    let metadata = std::fs::metadata(dir).map_err(|err| {
        StoreError::blob_storage(format!(
            "blob storage path is not accessible: {} ({err})",
            dir.display()
        ))
    })?;
    if !metadata.is_dir() {
        return Err(StoreError::blob_storage(format!(
            "blob storage path is not a directory: {}",
            dir.display()
        )));
    }
    Ok(())
}

/// TS uses `accessSync(dir, W_OK)`; std has no faccess, so probe by creating
/// (and removing) a throwaway file — the honest writability check.
fn assert_writable(dir: &Path) -> Result<(), StoreError> {
    let probe = dir.join(format!(
        ".frick-blob-write-probe.{}.{}",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(file) => {
            drop(file);
            let _ = std::fs::remove_file(&probe);
            Ok(())
        }
        Err(err) => Err(StoreError::blob_storage(format!(
            "blob storage path is not writable: {} ({err})",
            dir.display()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HELLO: &[u8] = b"hello blob";
    const WORLD: &[u8] = b"world blob";

    // ── encodeSegment conformance ──────────────────────────────────────────
    // Expected values computed by running the TS `encodeSegment`
    // (blob-bytes-driver.ts:557-565) in node — byte-identical or the Rust
    // server cannot read a TS server's blob tree.

    #[test]
    fn encode_segment_matches_ts_vectors() {
        assert_eq!(
            encode_segment("tenant-a"),
            "tenant-a.80a707af7dc77ee1228f9127180f3964"
        );
        assert_eq!(
            encode_segment("tenant-b"),
            "tenant-b.df6b6a5f230ea55af66fbc138653f509"
        );
        assert_eq!(
            encode_segment("blob-1"),
            "blob-1.201e33b22aa4f55a98fc6b5b14c6ab2b"
        );
        assert_eq!(
            encode_segment("app-a"),
            "app-a.f2524ca217411db466876bb97f8bc934"
        );
        assert_eq!(
            encode_segment("_default"),
            "_default.3bf305731dd26307a59c774cb22c6f9f"
        );
        // Traversal metacharacters collapse into '-' runs and trim away.
        assert_eq!(
            encode_segment("../../etc/passwd"),
            "etc-passwd.3754d6cb3a38e1185e5b382d5f3ef3f1"
        );
        // Lowercasing + run collapsing.
        assert_eq!(
            encode_segment("Hello World!.txt"),
            "hello-world-txt.2b798c84ea2b8a24792c0a9a91fbd2d7"
        );
        // Empty readable prefix ⇒ hash only.
        assert_eq!(encode_segment("!!!"), "e84c538e7fe250730ef62de220c40dfa");
        // Readable prefix capped at 40 chars AFTER trimming.
        assert_eq!(
            encode_segment(&"a".repeat(50)),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.160b4e433e384e05e537dc59b467f7cb"
        );
        assert_eq!(
            encode_segment(&"x!y".repeat(20)),
            "x-yx-yx-yx-yx-yx-yx-yx-yx-yx-yx-yx-yx-yx.9d501e5c26285e10d5a85073a7388867"
        );
        // Non-ASCII collapses; ASCII survivors keep their place.
        assert_eq!(
            encode_segment("café/ßK"),
            "caf-k.b1d9a0cedb72f8e07b40d5cd85515190"
        );
    }

    #[test]
    fn iso_from_epoch_ms_matches_date_to_iso_string() {
        // Vectors from `new Date(ms).toISOString()` in node.
        assert_eq!(iso_from_epoch_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_epoch_ms(1), "1970-01-01T00:00:00.001Z");
        assert_eq!(iso_from_epoch_ms(999), "1970-01-01T00:00:00.999Z");
        assert_eq!(
            iso_from_epoch_ms(1_700_000_000_123),
            "2023-11-14T22:13:20.123Z"
        );
        assert_eq!(
            iso_from_epoch_ms(951_827_696_789),
            "2000-02-29T12:34:56.789Z"
        );
        assert_eq!(
            iso_from_epoch_ms(4_102_444_799_999),
            "2099-12-31T23:59:59.999Z"
        );
        assert_eq!(
            iso_from_epoch_ms(1_456_704_000_000),
            "2016-02-29T00:00:00.000Z"
        );
        assert_eq!(iso_from_epoch_ms(-1), "1969-12-31T23:59:59.999Z");
    }

    // ── FilesystemBlobBytesDriver ──────────────────────────────────────────

    fn fs_driver() -> (tempfile::TempDir, FilesystemBlobBytesDriver) {
        let root = tempfile::tempdir().unwrap();
        let driver = FilesystemBlobBytesDriver::new(root.path().to_str().unwrap()).unwrap();
        (root, driver)
    }

    /// Every file under `root`, as absolute paths.
    fn files_under(root: &Path) -> Vec<PathBuf> {
        let mut found = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    found.push(path);
                }
            }
        }
        found.sort();
        found
    }

    #[test]
    fn filesystem_round_trips_bytes() {
        let (_root, driver) = fs_driver();

        assert!(!driver.exists("tenant-a", "blob-1", DEFAULT_APP_ID).unwrap());
        assert_eq!(
            driver.read("tenant-a", "blob-1", DEFAULT_APP_ID).unwrap(),
            None
        );

        driver
            .write("tenant-a", "blob-1", HELLO, DEFAULT_APP_ID)
            .unwrap();
        assert!(driver.exists("tenant-a", "blob-1", DEFAULT_APP_ID).unwrap());
        assert_eq!(
            driver.read("tenant-a", "blob-1", DEFAULT_APP_ID).unwrap(),
            Some(HELLO.to_vec())
        );

        driver.delete("tenant-a", "blob-1", DEFAULT_APP_ID).unwrap();
        assert!(!driver.exists("tenant-a", "blob-1", DEFAULT_APP_ID).unwrap());
        assert_eq!(
            driver.read("tenant-a", "blob-1", DEFAULT_APP_ID).unwrap(),
            None
        );
    }

    #[test]
    fn filesystem_overwrites_existing_bytes() {
        let (_root, driver) = fs_driver();
        driver
            .write("tenant-a", "blob-1", HELLO, DEFAULT_APP_ID)
            .unwrap();
        driver
            .write("tenant-a", "blob-1", WORLD, DEFAULT_APP_ID)
            .unwrap();
        assert_eq!(
            driver.read("tenant-a", "blob-1", DEFAULT_APP_ID).unwrap(),
            Some(WORLD.to_vec())
        );
    }

    #[test]
    fn filesystem_delete_on_missing_blob_is_noop() {
        let (_root, driver) = fs_driver();
        driver
            .delete("tenant-a", "missing", DEFAULT_APP_ID)
            .unwrap();
    }

    #[test]
    fn filesystem_isolates_tenants() {
        let (_root, driver) = fs_driver();
        // Same blobId in two different tenants must not collide or leak.
        driver
            .write("tenant-a", "shared-id", HELLO, DEFAULT_APP_ID)
            .unwrap();
        driver
            .write("tenant-b", "shared-id", WORLD, DEFAULT_APP_ID)
            .unwrap();

        assert_eq!(
            driver
                .read("tenant-a", "shared-id", DEFAULT_APP_ID)
                .unwrap(),
            Some(HELLO.to_vec())
        );
        assert_eq!(
            driver
                .read("tenant-b", "shared-id", DEFAULT_APP_ID)
                .unwrap(),
            Some(WORLD.to_vec())
        );

        // tenant-b's blob is invisible to tenant-c.
        assert_eq!(
            driver
                .read("tenant-c", "shared-id", DEFAULT_APP_ID)
                .unwrap(),
            None
        );
        assert!(
            !driver
                .exists("tenant-c", "shared-id", DEFAULT_APP_ID)
                .unwrap()
        );

        // Deleting one tenant's copy leaves the other intact.
        driver
            .delete("tenant-a", "shared-id", DEFAULT_APP_ID)
            .unwrap();
        assert!(
            !driver
                .exists("tenant-a", "shared-id", DEFAULT_APP_ID)
                .unwrap()
        );
        assert_eq!(
            driver
                .read("tenant-b", "shared-id", DEFAULT_APP_ID)
                .unwrap(),
            Some(WORLD.to_vec())
        );
    }

    #[test]
    fn filesystem_layout_is_byte_identical_to_ts() {
        let (root, driver) = fs_driver();
        driver
            .write("tenant-a", "blob-1", HELLO, DEFAULT_APP_ID)
            .unwrap();

        // The _default app omits the app segment: <root>/<tenant>/<aa>/<blob>.
        let expected = root
            .path()
            .join("tenant-a.80a707af7dc77ee1228f9127180f3964")
            .join("bl")
            .join("blob-1.201e33b22aa4f55a98fc6b5b14c6ab2b");
        assert_eq!(std::fs::read(&expected).unwrap(), HELLO);

        // Non-default apps get their own encoded segment in front.
        driver.write("tenant-a", "blob-1", WORLD, "app-a").unwrap();
        let expected_app = root
            .path()
            .join("app-a.f2524ca217411db466876bb97f8bc934")
            .join("tenant-a.80a707af7dc77ee1228f9127180f3964")
            .join("bl")
            .join("blob-1.201e33b22aa4f55a98fc6b5b14c6ab2b");
        assert_eq!(std::fs::read(&expected_app).unwrap(), WORLD);

        // The two app partitions never collided.
        assert_eq!(
            driver.read("tenant-a", "blob-1", DEFAULT_APP_ID).unwrap(),
            Some(HELLO.to_vec())
        );
        assert_eq!(
            driver.read("tenant-a", "blob-1", "app-a").unwrap(),
            Some(WORLD.to_vec())
        );
    }

    #[test]
    fn filesystem_confines_path_traversal_ids_to_the_root() {
        let (root, driver) = fs_driver();
        driver
            .write("tenant-a", "../../etc/passwd", HELLO, DEFAULT_APP_ID)
            .unwrap();
        // Bytes are recoverable only via the same (tenantId, blobId) pair...
        assert_eq!(
            driver
                .read("tenant-a", "../../etc/passwd", DEFAULT_APP_ID)
                .unwrap(),
            Some(HELLO.to_vec())
        );
        // ...and the single file written lives under the root, at the encoded
        // path (no `..` survives encoding).
        let files = files_under(root.path());
        let expected = root
            .path()
            .join("tenant-a.80a707af7dc77ee1228f9127180f3964")
            .join("et")
            .join("etc-passwd.3754d6cb3a38e1185e5b382d5f3ef3f1");
        assert_eq!(files, vec![expected]);
    }

    #[test]
    fn filesystem_fails_fast_when_root_is_not_a_writable_directory() {
        let root = tempfile::tempdir().unwrap();
        // A regular file blocks mkdir of a directory beneath it (ENOTDIR).
        let blocker = root.path().join("blocker-file");
        std::fs::write(&blocker, b"not a directory").unwrap();
        let nested = blocker.join("nested");
        let err = FilesystemBlobBytesDriver::new(nested.to_str().unwrap()).unwrap_err();
        assert!(matches!(err, StoreError::BlobStorage(_)));
        assert!(
            err.to_string()
                .starts_with("blob storage path is not creatable: "),
            "unexpected message: {err}"
        );
    }

    // ── SqlBlobBytesDriver ─────────────────────────────────────────────────

    const BYTES_SCHEMA: &str = "
        CREATE TABLE blob_metadata (
          blob_id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          byte_length INTEGER NOT NULL,
          mime_type TEXT NOT NULL,
          storage_key TEXT,
          created_at TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT '_default',
          app_id TEXT NOT NULL DEFAULT '_default'
        );
        CREATE TABLE blob_content (
          blob_id TEXT PRIMARY KEY,
          content BLOB NOT NULL,
          updated_at TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT '_default',
          app_id TEXT NOT NULL DEFAULT '_default',
          FOREIGN KEY (blob_id) REFERENCES blob_metadata(blob_id) ON DELETE CASCADE
        );";

    async fn sql_bytes_driver() -> (Arc<SqlDriver>, SqlBlobBytesDriver) {
        let sql = Arc::new(SqlDriver::open_sqlite(":memory:").unwrap());
        sql.exec(BYTES_SCHEMA).await.unwrap();
        let driver = SqlBlobBytesDriver::new(Arc::clone(&sql));
        (sql, driver)
    }

    #[tokio::test]
    async fn sql_round_trips_bytes_and_stamps_updated_at() {
        let (sql, driver) = sql_bytes_driver().await;

        assert!(
            !driver
                .exists("tenant-a", "blob-1", DEFAULT_APP_ID)
                .await
                .unwrap()
        );
        assert_eq!(
            driver
                .read("tenant-a", "blob-1", DEFAULT_APP_ID)
                .await
                .unwrap(),
            None
        );

        driver
            .write(
                "tenant-a",
                "blob-1",
                HELLO,
                DEFAULT_APP_ID,
                1_700_000_000_123,
            )
            .await
            .unwrap();
        assert!(
            driver
                .exists("tenant-a", "blob-1", DEFAULT_APP_ID)
                .await
                .unwrap()
        );
        assert_eq!(
            driver
                .read("tenant-a", "blob-1", DEFAULT_APP_ID)
                .await
                .unwrap(),
            Some(HELLO.to_vec())
        );

        let row = sql
            .get(
                "SELECT updated_at FROM blob_content WHERE blob_id = ?",
                &["blob-1".into()],
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.text("updated_at"), Some("2023-11-14T22:13:20.123Z"));

        // Overwrite refreshes content + updated_at via ON CONFLICT(blob_id).
        driver
            .write(
                "tenant-a",
                "blob-1",
                WORLD,
                DEFAULT_APP_ID,
                1_700_000_001_000,
            )
            .await
            .unwrap();
        assert_eq!(
            driver
                .read("tenant-a", "blob-1", DEFAULT_APP_ID)
                .await
                .unwrap(),
            Some(WORLD.to_vec())
        );

        driver
            .delete("tenant-a", "blob-1", DEFAULT_APP_ID)
            .await
            .unwrap();
        assert!(
            !driver
                .exists("tenant-a", "blob-1", DEFAULT_APP_ID)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn sql_reads_filter_by_app_and_tenant() {
        let (_sql, driver) = sql_bytes_driver().await;
        driver
            .write("tenant-a", "blob-1", HELLO, "app-a", 0)
            .await
            .unwrap();

        assert_eq!(
            driver.read("tenant-a", "blob-1", "app-a").await.unwrap(),
            Some(HELLO.to_vec())
        );
        assert_eq!(
            driver.read("tenant-a", "blob-1", "app-b").await.unwrap(),
            None
        );
        assert_eq!(
            driver
                .read("tenant-a", "blob-1", DEFAULT_APP_ID)
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            driver.read("tenant-b", "blob-1", "app-a").await.unwrap(),
            None
        );

        // An app-mismatched delete is a no-op for the owning row.
        driver.delete("tenant-a", "blob-1", "app-b").await.unwrap();
        assert!(driver.exists("tenant-a", "blob-1", "app-a").await.unwrap());
    }

    // ── S3 stub + factory ──────────────────────────────────────────────────

    #[test]
    fn s3_stub_returns_the_follow_up_error() {
        let driver = S3BlobBytesDriver;
        for err in [
            driver.write("t", "b", HELLO, DEFAULT_APP_ID).unwrap_err(),
            driver
                .read("t", "b", DEFAULT_APP_ID)
                .map(|_| ())
                .unwrap_err(),
            driver.delete("t", "b", DEFAULT_APP_ID).unwrap_err(),
            driver
                .exists("t", "b", DEFAULT_APP_ID)
                .map(|_| ())
                .unwrap_err(),
        ] {
            assert!(matches!(err, StoreError::Store(_)));
            assert_eq!(
                err.to_string(),
                "s3 blob bytes driver not yet ported (FR-241 follow-up)"
            );
        }
    }

    #[tokio::test]
    async fn factory_selects_and_validates_drivers() {
        let sql = Arc::new(SqlDriver::open_sqlite(":memory:").unwrap());

        // Default: the seam-backed sql driver.
        let driver = create_blob_bytes_driver(FrickBlobDriver::Sqlite, &sql, None).unwrap();
        assert!(matches!(driver, BlobBytesDriver::Sql(_)));

        // Filesystem with a path builds the filesystem driver.
        let root = tempfile::tempdir().unwrap();
        let driver = create_blob_bytes_driver(
            FrickBlobDriver::Filesystem,
            &sql,
            Some(root.path().to_str().unwrap()),
        )
        .unwrap();
        assert!(matches!(driver, BlobBytesDriver::Filesystem(_)));

        // Filesystem without (or with a blank) path fails clearly.
        for path in [None, Some("   ")] {
            let err =
                create_blob_bytes_driver(FrickBlobDriver::Filesystem, &sql, path).unwrap_err();
            assert!(matches!(err, StoreError::BlobStorage(_)));
            assert!(err.to_string().contains("requires FRICK_BLOB_STORAGE_PATH"));
        }

        // S3 selects the stub seam (errors at use, not at construction).
        let driver = create_blob_bytes_driver(FrickBlobDriver::S3, &sql, None).unwrap();
        assert!(matches!(driver, BlobBytesDriver::S3(_)));
        let err = driver.read("t", "b", DEFAULT_APP_ID).await.unwrap_err();
        assert_eq!(err.to_string(), S3_BLOB_BYTES_STUB_MESSAGE);
    }
}
