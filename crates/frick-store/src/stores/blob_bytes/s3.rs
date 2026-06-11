//! S3 / object-store blob-bytes driver (FR-273, FR-54), the production port of
//! the deleted TS `S3BlobBytesDriver` + `createS3BlobBytesDriver`
//! (`apps/server/src/storage/blob-bytes-driver.ts`). Blob *metadata* always
//! lives in SQL; only the raw *bytes* live in object storage, keyed by a
//! tenant-isolated, content-addressed prefix:
//!
//! ```text
//! <prefix>/<appSegment>/<tenantSegment>/<aa>/<blobSegment>
//! ```
//!
//! where the segments are [`encode_segment`](super::encode_segment) encodings
//! (`[a-z0-9_-]` + a single `.`) and `<aa>` is the two-char fan-out prefix of
//! the blob segment. The `_default` app omits its segment, byte-identical to the
//! filesystem driver's layout. Because every key is a deterministic hash of the
//! identifiers, an id containing `/`, `..`, or other metacharacters can never
//! address another tenant's objects — cross-tenant access is structurally
//! impossible (the same property the filesystem driver enforces on disk).
//!
//! ## Determinism / testability
//!
//! Live S3 is a network boundary, so the *pure* parts — the object-key mapping
//! ([`s3_object_key`]), prefix normalisation ([`normalize_prefix`]), and the
//! resolved client settings ([`ResolvedS3Settings::resolve`]) — are factored out
//! and unit-tested without any AWS reachability. The actual transport (the
//! [`object_store`] `AmazonS3` client) is built once at construction and only
//! exercised when the `s3` driver is selected by config; the default sqlite /
//! filesystem drivers never touch it.

use std::sync::Arc;

use object_store::aws::AmazonS3Builder;
use object_store::path::Path as ObjectPath;
use object_store::{ObjectStore, ObjectStoreExt};

use crate::error::StoreError;

use super::{DEFAULT_APP_ID, encode_segment};

/// Configuration for the S3 blob-bytes driver (TS `S3BlobBytesDriverConfig`).
/// `bucket` is required; everything else is optional and falls back to the AWS
/// default chain / sensible defaults. Mirrors the `FRICK_BLOB_S3_*` env surface
/// the server config already parses.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct S3BlobBytesConfig {
    /// Target bucket. Required (`FRICK_BLOB_S3_BUCKET`).
    pub bucket: String,
    /// AWS region (`FRICK_BLOB_S3_REGION`). Optional for S3-compatible stores
    /// that ignore it.
    pub region: Option<String>,
    /// Custom endpoint for S3-compatible stores — MinIO, R2, Spaces, …
    /// (`FRICK_BLOB_S3_ENDPOINT`). Omit for real AWS S3.
    pub endpoint: Option<String>,
    /// Key prefix every object lives under (`FRICK_BLOB_S3_PREFIX`). Optional.
    pub prefix: Option<String>,
    /// Force path-style addressing (`<endpoint>/<bucket>/<key>` instead of
    /// `<bucket>.<endpoint>/<key>`, `FRICK_BLOB_S3_FORCE_PATH_STYLE`). Most
    /// S3-compatible stores need this; `None` ⇒ defaults to `true` when a custom
    /// `endpoint` is set, `false` otherwise (TS `config.forcePathStyle ??
    /// Boolean(config.endpoint)`).
    pub force_path_style: Option<bool>,
    /// Optional static access key id. When both this and [`secret_access_key`]
    /// are present they pin the credentials; otherwise the standard AWS
    /// environment chain (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/…) is used.
    ///
    /// [`secret_access_key`]: Self::secret_access_key
    pub access_key_id: Option<String>,
    /// Optional static secret access key (see [`access_key_id`]).
    ///
    /// [`access_key_id`]: Self::access_key_id
    pub secret_access_key: Option<String>,
}

/// The settings the [`object_store`] client is actually built from, after
/// resolving the optional/defaulted fields. Pure and `PartialEq` so the
/// resolution logic (notably `force_path_style`) is unit-testable without
/// touching the network or the AWS SDK.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedS3Settings {
    pub bucket: String,
    pub region: Option<String>,
    pub endpoint: Option<String>,
    /// The normalised, slash-trimmed key prefix (possibly empty).
    pub prefix: String,
    pub force_path_style: bool,
    /// `Some((key, secret))` when static credentials were supplied; `None` ⇒ the
    /// default AWS credential chain.
    pub static_credentials: Option<(String, String)>,
    /// Whether the endpoint is plaintext `http://` (so the client must be told
    /// to allow non-TLS — MinIO in dev, mostly).
    pub allow_http: bool,
}

impl ResolvedS3Settings {
    /// Resolve a [`S3BlobBytesConfig`] into the concrete client settings,
    /// applying the TS defaulting rules. Returns a [`StoreError::BlobStorage`]
    /// when the required `bucket` is blank — the same failure the TS
    /// `createS3BlobBytesDriver` raises.
    pub fn resolve(config: &S3BlobBytesConfig) -> Result<Self, StoreError> {
        let bucket = config.bucket.trim();
        if bucket.is_empty() {
            return Err(StoreError::blob_storage(
                "the s3 blob driver requires FRICK_BLOB_S3_BUCKET to be set to a bucket name",
            ));
        }
        let endpoint = trimmed_nonempty(config.endpoint.as_deref());
        // TS: `config.forcePathStyle ?? Boolean(config.endpoint)`.
        let force_path_style = config.force_path_style.unwrap_or(endpoint.is_some());
        let allow_http = endpoint
            .as_deref()
            .is_some_and(|e| e.starts_with("http://"));
        let static_credentials = match (
            trimmed_nonempty(config.access_key_id.as_deref()),
            trimmed_nonempty(config.secret_access_key.as_deref()),
        ) {
            (Some(key), Some(secret)) => Some((key, secret)),
            // A lone key (or lone secret) is ignored — fall through to the AWS
            // default chain, matching the TS `if (accessKeyId && secretAccessKey)`.
            _ => None,
        };
        Ok(Self {
            bucket: bucket.to_string(),
            region: trimmed_nonempty(config.region.as_deref()),
            endpoint,
            prefix: normalize_prefix(config.prefix.as_deref()),
            force_path_style,
            static_credentials,
            allow_http,
        })
    }
}

/// `Some(trimmed)` when `value` is present and non-blank, else `None`.
fn trimmed_nonempty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
}

/// Normalise an optional key prefix to a `/`-joined chain with no leading,
/// trailing, empty, or whitespace-only segments (TS constructor's
/// `split("/").map(trim).filter(length>0).join("/")`). The result is either
/// empty or a clean `a/b/c` chain so [`s3_object_key`] can join unconditionally.
#[must_use]
pub fn normalize_prefix(prefix: Option<&str>) -> String {
    prefix
        .unwrap_or("")
        .split('/')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

/// Map `(app_id, tenant_id, blob_id)` to the object key, byte-identical to the
/// TS `#keyFor` (`blob-bytes-driver.ts`): `<prefix>/<appSegment>/<tenantSegment>/
/// <aa>/<blobSegment>`, with empty parts (prefix and the `_default` app segment)
/// filtered out. `prefix` MUST already be normalised (see [`normalize_prefix`]).
///
/// The output contains only `[a-z0-9_-]`, `.`, and `/` separators between
/// encoded segments, so a crafted id can never escape its tenant's key space.
#[must_use]
pub fn s3_object_key(prefix: &str, app_id: &str, tenant_id: &str, blob_id: &str) -> String {
    let tenant_segment = encode_segment(tenant_id);
    let blob_segment = encode_segment(blob_id);
    let fanout = &blob_segment[..2];
    // FR-153: non-default apps get their own encoded key segment so two apps'
    // blobs never address the same object. `_default` keeps the historical key.
    let app_segment = if app_id == DEFAULT_APP_ID {
        String::new()
    } else {
        encode_segment(app_id)
    };
    [prefix, &app_segment, &tenant_segment, fanout, &blob_segment]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

/// Object-storage / S3-compatible blob-bytes driver (TS `S3BlobBytesDriver`,
/// FR-54/FR-273). Holds an [`object_store`] client and the normalised key
/// prefix; every method maps `(app, tenant, blob)` to an object key via
/// [`s3_object_key`] and is fully async.
#[derive(Clone)]
pub struct S3BlobBytesDriver {
    store: Arc<dyn ObjectStore>,
    prefix: String,
}

impl std::fmt::Debug for S3BlobBytesDriver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("S3BlobBytesDriver")
            .field("prefix", &self.prefix)
            .finish_non_exhaustive()
    }
}

impl S3BlobBytesDriver {
    /// Build the driver from config, constructing the underlying `AmazonS3`
    /// client. Fails fast (TS `createS3BlobBytesDriver`) when the bucket is
    /// blank or the client cannot be configured — surfaced at store construction
    /// so a misconfigured `s3` driver never starts the server half-broken.
    pub fn from_config(config: &S3BlobBytesConfig) -> Result<Self, StoreError> {
        let settings = ResolvedS3Settings::resolve(config)?;
        let store = build_amazon_s3(&settings)?;
        Ok(Self {
            store: Arc::new(store),
            prefix: settings.prefix,
        })
    }

    /// Construct directly over a pre-built [`ObjectStore`] (the in-memory store
    /// in tests, a custom client in embedders). `prefix` is normalised here so
    /// callers need not pre-clean it.
    #[must_use]
    pub fn with_store(store: Arc<dyn ObjectStore>, prefix: Option<&str>) -> Self {
        Self {
            store,
            prefix: normalize_prefix(prefix),
        }
    }

    fn key_for(&self, tenant_id: &str, blob_id: &str, app_id: &str) -> ObjectPath {
        // `from_absolute_path`-style construction would reject our keys; the
        // string is already free of `..`/leading-slash, so the percent-encoding
        // `Path::from` would apply never triggers for our `[a-z0-9_-.]` alphabet.
        ObjectPath::from(s3_object_key(&self.prefix, app_id, tenant_id, blob_id))
    }

    /// Persist (or overwrite) the bytes at the object key (TS `write`).
    pub async fn write(
        &self,
        tenant_id: &str,
        blob_id: &str,
        content: &[u8],
        app_id: &str,
    ) -> Result<(), StoreError> {
        let key = self.key_for(tenant_id, blob_id, app_id);
        // `Vec<u8>` → `PutPayload`; one owned copy is unavoidable across the
        // async boundary (the SQL/fs drivers copy too).
        let payload = object_store::PutPayload::from(content.to_vec());
        self.store.put(&key, payload).await.map_err(|err| {
            StoreError::blob_storage(format!("failed to write blob bytes for {blob_id}: {err}"))
        })?;
        Ok(())
    }

    /// Read the bytes at the object key, or `None` when the key is absent (TS
    /// `read`; the `S3LikeClient` maps `NoSuchKey`/404 to `undefined`).
    pub async fn read(
        &self,
        tenant_id: &str,
        blob_id: &str,
        app_id: &str,
    ) -> Result<Option<Vec<u8>>, StoreError> {
        let key = self.key_for(tenant_id, blob_id, app_id);
        match self.store.get(&key).await {
            Ok(result) => {
                let bytes = result.bytes().await.map_err(|err| {
                    StoreError::blob_storage(format!(
                        "failed to read blob bytes for {blob_id}: {err}"
                    ))
                })?;
                Ok(Some(bytes.to_vec()))
            }
            Err(object_store::Error::NotFound { .. }) => Ok(None),
            Err(err) => Err(StoreError::blob_storage(format!(
                "failed to read blob bytes for {blob_id}: {err}"
            ))),
        }
    }

    /// Delete the bytes at the object key. Absent is a no-op (TS `delete`).
    pub async fn delete(
        &self,
        tenant_id: &str,
        blob_id: &str,
        app_id: &str,
    ) -> Result<(), StoreError> {
        let key = self.key_for(tenant_id, blob_id, app_id);
        match self.store.delete(&key).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => Ok(()),
            Err(err) => Err(StoreError::blob_storage(format!(
                "failed to delete blob bytes for {blob_id}: {err}"
            ))),
        }
    }

    /// Whether an object exists at the key (TS `exists`/`headObject`).
    pub async fn exists(
        &self,
        tenant_id: &str,
        blob_id: &str,
        app_id: &str,
    ) -> Result<bool, StoreError> {
        let key = self.key_for(tenant_id, blob_id, app_id);
        match self.store.head(&key).await {
            Ok(_) => Ok(true),
            Err(object_store::Error::NotFound { .. }) => Ok(false),
            Err(err) => Err(StoreError::blob_storage(format!(
                "failed to stat blob bytes for {blob_id}: {err}"
            ))),
        }
    }
}

/// Build an [`object_store`] `AmazonS3` client from resolved settings. Starts
/// from [`AmazonS3Builder::from_env`] so the standard AWS environment chain
/// (region, credentials, session token, …) is honoured, then layers the
/// explicit config on top (explicit wins). Errors map to
/// [`StoreError::BlobStorage`].
fn build_amazon_s3(
    settings: &ResolvedS3Settings,
) -> Result<object_store::aws::AmazonS3, StoreError> {
    let mut builder = AmazonS3Builder::from_env()
        .with_bucket_name(&settings.bucket)
        .with_virtual_hosted_style_request(!settings.force_path_style);
    if let Some(region) = &settings.region {
        builder = builder.with_region(region);
    }
    if let Some(endpoint) = &settings.endpoint {
        builder = builder.with_endpoint(endpoint);
    }
    if settings.allow_http {
        builder = builder.with_allow_http(true);
    }
    if let Some((key, secret)) = &settings.static_credentials {
        builder = builder
            .with_access_key_id(key)
            .with_secret_access_key(secret);
    }
    builder.build().map_err(|err| {
        StoreError::blob_storage(format!("the s3 blob driver failed to initialise: {err}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── key mapping (byte-identical to the TS `#keyFor`) ────────────────────

    #[test]
    fn object_key_default_app_omits_app_segment() {
        // <tenantSegment>/<aa>/<blobSegment> — same encodings as the fs driver.
        assert_eq!(
            s3_object_key("", DEFAULT_APP_ID, "tenant-a", "blob-1"),
            "tenant-a.80a707af7dc77ee1228f9127180f3964/bl/blob-1.201e33b22aa4f55a98fc6b5b14c6ab2b"
        );
    }

    #[test]
    fn object_key_non_default_app_prepends_app_segment() {
        assert_eq!(
            s3_object_key("", "app-a", "tenant-a", "blob-1"),
            "app-a.f2524ca217411db466876bb97f8bc934/\
             tenant-a.80a707af7dc77ee1228f9127180f3964/bl/\
             blob-1.201e33b22aa4f55a98fc6b5b14c6ab2b"
        );
    }

    #[test]
    fn object_key_prepends_prefix_when_present() {
        assert_eq!(
            s3_object_key("blobs/v1", DEFAULT_APP_ID, "tenant-a", "blob-1"),
            "blobs/v1/tenant-a.80a707af7dc77ee1228f9127180f3964/bl/\
             blob-1.201e33b22aa4f55a98fc6b5b14c6ab2b"
        );
    }

    #[test]
    fn object_key_confines_traversal_ids() {
        // `../../etc/passwd` encodes to a single safe segment — no `/` or `..`
        // survives, so the key can never escape the tenant prefix.
        let key = s3_object_key("p", DEFAULT_APP_ID, "tenant-a", "../../etc/passwd");
        assert_eq!(
            key,
            "p/tenant-a.80a707af7dc77ee1228f9127180f3964/et/\
             etc-passwd.3754d6cb3a38e1185e5b382d5f3ef3f1"
        );
        assert!(!key.contains(".."));
    }

    #[test]
    fn object_key_isolates_tenants_and_apps() {
        let a = s3_object_key("", DEFAULT_APP_ID, "tenant-a", "shared");
        let b = s3_object_key("", DEFAULT_APP_ID, "tenant-b", "shared");
        let app = s3_object_key("", "app-a", "tenant-a", "shared");
        assert_ne!(a, b, "same blob id in different tenants must not collide");
        assert_ne!(
            a, app,
            "same (tenant, blob) in different apps must not collide"
        );
    }

    // ── prefix normalisation ────────────────────────────────────────────────

    #[test]
    fn normalize_prefix_collapses_and_trims() {
        assert_eq!(normalize_prefix(None), "");
        assert_eq!(normalize_prefix(Some("")), "");
        assert_eq!(normalize_prefix(Some("/")), "");
        assert_eq!(normalize_prefix(Some("///")), "");
        assert_eq!(normalize_prefix(Some("/blobs/")), "blobs");
        assert_eq!(normalize_prefix(Some("blobs//v1//")), "blobs/v1");
        assert_eq!(normalize_prefix(Some("  a / b ")), "a/b");
    }

    // ── settings resolution (forcePathStyle / credentials / allow_http) ──────

    fn config(bucket: &str) -> S3BlobBytesConfig {
        S3BlobBytesConfig {
            bucket: bucket.to_string(),
            ..S3BlobBytesConfig::default()
        }
    }

    #[test]
    fn resolve_requires_bucket() {
        for blank in ["", "   "] {
            let err = ResolvedS3Settings::resolve(&config(blank)).unwrap_err();
            assert!(matches!(err, StoreError::BlobStorage(_)));
            assert!(err.to_string().contains("FRICK_BLOB_S3_BUCKET"), "{err}");
        }
    }

    #[test]
    fn resolve_force_path_style_defaults_to_endpoint_presence() {
        // No endpoint ⇒ virtual-hosted (force_path_style = false).
        let real_aws = ResolvedS3Settings::resolve(&config("bucket")).unwrap();
        assert!(!real_aws.force_path_style);

        // Custom endpoint ⇒ path-style by default (most S3-compatible stores).
        let mut with_endpoint = config("bucket");
        with_endpoint.endpoint = Some("https://minio.example:9000".into());
        let resolved = ResolvedS3Settings::resolve(&with_endpoint).unwrap();
        assert!(resolved.force_path_style);
        assert!(!resolved.allow_http, "https endpoint stays TLS");

        // An explicit override beats the endpoint heuristic, both ways.
        let mut forced_off = with_endpoint.clone();
        forced_off.force_path_style = Some(false);
        assert!(
            !ResolvedS3Settings::resolve(&forced_off)
                .unwrap()
                .force_path_style
        );

        let mut forced_on = config("bucket");
        forced_on.force_path_style = Some(true);
        assert!(
            ResolvedS3Settings::resolve(&forced_on)
                .unwrap()
                .force_path_style
        );
    }

    #[test]
    fn resolve_allow_http_only_for_plaintext_endpoint() {
        let mut http = config("bucket");
        http.endpoint = Some("http://localhost:9000".into());
        assert!(ResolvedS3Settings::resolve(&http).unwrap().allow_http);
    }

    #[test]
    fn resolve_static_credentials_require_both_halves() {
        let mut only_key = config("bucket");
        only_key.access_key_id = Some("AKIA".into());
        assert_eq!(
            ResolvedS3Settings::resolve(&only_key)
                .unwrap()
                .static_credentials,
            None,
            "a lone access key falls through to the default chain"
        );

        let mut both = config("bucket");
        both.access_key_id = Some(" AKIA ".into());
        both.secret_access_key = Some(" secret ".into());
        assert_eq!(
            ResolvedS3Settings::resolve(&both)
                .unwrap()
                .static_credentials,
            Some(("AKIA".to_string(), "secret".to_string())),
            "credentials are trimmed and paired"
        );
    }

    #[test]
    fn resolve_trims_optional_fields() {
        let mut cfg = config(" bucket ");
        cfg.region = Some("  us-east-1 ".into());
        cfg.endpoint = Some("   ".into()); // blank ⇒ None
        cfg.prefix = Some("/blobs/v1/".into());
        let resolved = ResolvedS3Settings::resolve(&cfg).unwrap();
        assert_eq!(resolved.bucket, "bucket");
        assert_eq!(resolved.region.as_deref(), Some("us-east-1"));
        assert_eq!(resolved.endpoint, None);
        assert_eq!(resolved.prefix, "blobs/v1");
        // No endpoint and no explicit override ⇒ virtual-hosted.
        assert!(!resolved.force_path_style);
    }

    // ── live driver behaviour, against an in-memory object store ────────────
    //
    // Exercises the async write/read/delete/exists + key isolation paths
    // through the real `ObjectStore` trait, without any S3 reachability.

    fn memory_driver(prefix: Option<&str>) -> S3BlobBytesDriver {
        let store: Arc<dyn ObjectStore> = Arc::new(object_store::memory::InMemory::new());
        S3BlobBytesDriver::with_store(store, prefix)
    }

    #[tokio::test]
    async fn round_trips_bytes() {
        let driver = memory_driver(Some("blobs"));
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
            .write("tenant-a", "blob-1", b"hello s3", DEFAULT_APP_ID)
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
            Some(b"hello s3".to_vec())
        );

        // Overwrite replaces the bytes.
        driver
            .write("tenant-a", "blob-1", b"world s3", DEFAULT_APP_ID)
            .await
            .unwrap();
        assert_eq!(
            driver
                .read("tenant-a", "blob-1", DEFAULT_APP_ID)
                .await
                .unwrap(),
            Some(b"world s3".to_vec())
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
        // Delete on a missing key is a no-op.
        driver
            .delete("tenant-a", "blob-1", DEFAULT_APP_ID)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn isolates_tenants_and_apps() {
        let driver = memory_driver(None);
        driver
            .write("tenant-a", "shared", b"A", DEFAULT_APP_ID)
            .await
            .unwrap();
        driver
            .write("tenant-b", "shared", b"B", DEFAULT_APP_ID)
            .await
            .unwrap();
        driver
            .write("tenant-a", "shared", b"APP", "app-a")
            .await
            .unwrap();

        assert_eq!(
            driver
                .read("tenant-a", "shared", DEFAULT_APP_ID)
                .await
                .unwrap(),
            Some(b"A".to_vec())
        );
        assert_eq!(
            driver
                .read("tenant-b", "shared", DEFAULT_APP_ID)
                .await
                .unwrap(),
            Some(b"B".to_vec())
        );
        assert_eq!(
            driver.read("tenant-a", "shared", "app-a").await.unwrap(),
            Some(b"APP".to_vec())
        );
        // A third tenant sees nothing.
        assert_eq!(
            driver
                .read("tenant-c", "shared", DEFAULT_APP_ID)
                .await
                .unwrap(),
            None
        );

        // Deleting one tenant's copy leaves the others intact.
        driver
            .delete("tenant-a", "shared", DEFAULT_APP_ID)
            .await
            .unwrap();
        assert!(
            !driver
                .exists("tenant-a", "shared", DEFAULT_APP_ID)
                .await
                .unwrap()
        );
        assert_eq!(
            driver
                .read("tenant-b", "shared", DEFAULT_APP_ID)
                .await
                .unwrap(),
            Some(b"B".to_vec())
        );
        assert_eq!(
            driver.read("tenant-a", "shared", "app-a").await.unwrap(),
            Some(b"APP".to_vec())
        );
    }

    #[tokio::test]
    async fn traversal_id_round_trips_under_a_safe_key() {
        let driver = memory_driver(None);
        driver
            .write("tenant-a", "../../etc/passwd", b"safe", DEFAULT_APP_ID)
            .await
            .unwrap();
        assert_eq!(
            driver
                .read("tenant-a", "../../etc/passwd", DEFAULT_APP_ID)
                .await
                .unwrap(),
            Some(b"safe".to_vec())
        );
    }
}
