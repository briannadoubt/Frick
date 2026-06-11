//! The multi-app registry (FR-277, map 02 §10 + `apps/registry.ts`).
//!
//! A Frick "app" is a distinct schema mounted at a URL prefix on a
//! server whose storage is shared but partitioned by `app_id`. URL routing (for
//! HTTP) and the Hello-advertised `schemaId` (for WebSocket) select the active
//! app at the request boundary; the resolved app's id becomes the storage
//! `app_id` — **but only on a genuine multi-app server**. A server that holds a
//! single app keeps every storage call pinned to `_default`, so existing data
//! and the entire single-app code path stay byte-for-byte unchanged
//! (`src/server.ts:1159-1172`; map 02 §7, quirk: storage app id only diverges
//! from `_default` when >1 app is registered).
//!
//! ## What this module owns
//!
//! - [`AppEntry`]: one registered app — `{ id, base_path, schema, projections,
//!   search }`. The `projections`/`search` registries are per-app: app A's
//!   projection never fires on app B's writes (map 02 §10).
//! - [`FrickAppRegistry`] (`createFrickAppRegistry`): construction-time
//!   validation (unique ids + base_paths; base_path starts with `/`, no trailing
//!   slash; `""` allowed once for the root app), longest-prefix
//!   [`resolve_by_path`](FrickAppRegistry::resolve_by_path),
//!   [`find_by_schema_id`](FrickAppRegistry::find_by_schema_id),
//!   [`get`](FrickAppRegistry::get), [`len`](FrickAppRegistry::len),
//!   [`is_multi_app`](FrickAppRegistry::is_multi_app),
//!   [`storage_app_id`](FrickAppRegistry::storage_app_id) (the load-bearing
//!   single-app rule), and [`descriptors`](FrickAppRegistry::descriptors) for
//!   `GET /_frick/inspect/apps`.
//!
//! ## Determinism / ordering
//!
//! Apps are held in registration order (so `descriptors` and `find_by_schema_id`
//! are deterministic). A separate longest-base_path-first ordering drives
//! [`resolve_by_path`](FrickAppRegistry::resolve_by_path) so the most specific
//! prefix wins; the `""` root app is the universal fallback (longest match still
//! beats it because its base_path length is 0).

use frick_protocol::FrickSchema;

use crate::config::FrickConfigError;
use crate::principal::DEFAULT_APP_ID;
use crate::projections::ProjectionRegistry;
use crate::search::SearchRegistry;

/// A single registered app: its identity, mount prefix, schema, and the per-app
/// projection + search registries (`FrickAppDefinition` + the per-app registry
/// set, map 02 §10).
///
/// The per-app registries are independent `Arc`-backed handles: app A's
/// [`ProjectionRegistry`] / [`SearchRegistry`] is a different instance from app
/// B's, so a write made under app A's id only drives app A's projections /
/// indexes. For the `_default` app the boot path deliberately hands the SAME
/// registry handles it stores on [`crate::http::AppStateInner`] (they are
/// `Arc`-backed clones sharing one interior), so registering a projection on
/// `state.projections` is visible via `registry.get("_default").projections` —
/// see the [`crate::http::AppStateInner`] doc.
pub struct AppEntry {
    /// Stable identifier, e.g. `"chat"` or the framework default `_default`.
    pub id: String,
    /// URL prefix the app is mounted under: starts with `/`, no trailing slash;
    /// `""` for the single root app.
    pub base_path: String,
    /// The app's schema (returned from `GET <base_path>/schema`; used for Hello
    /// compatibility + `find_by_schema_id` WS routing).
    pub schema: FrickSchema,
    /// Projections scoped to THIS app (FR-277). For `_default` this shares the
    /// `Arc` interior with `AppStateInner::projections`.
    pub projections: ProjectionRegistry,
    /// Search indexes scoped to THIS app (FR-277). For `_default` this shares
    /// the `Arc` interior with `AppStateInner::search`.
    pub search: SearchRegistry,
}

/// A declarative app description for the multi-app boot path
/// (`FrickAppDefinition` minus the projections/jobs, which are registered after
/// construction via the per-app registry handles). The single-app boot helpers
/// never build one of these — they synthesize a `_default` [`AppEntry`]
/// directly.
#[derive(Debug, Clone)]
pub struct AppDefinition {
    /// Stable identifier, e.g. `"chat"`.
    pub id: String,
    /// URL prefix: starts with `/`, no trailing slash; `""` for the root app.
    pub base_path: String,
    /// The app's schema.
    pub schema: FrickSchema,
}

impl AppDefinition {
    /// Construct an app definition.
    #[must_use]
    pub fn new(id: impl Into<String>, base_path: impl Into<String>, schema: FrickSchema) -> Self {
        Self {
            id: id.into(),
            base_path: base_path.into(),
            schema,
        }
    }
}

/// A successful longest-prefix path lookup (`FrickAppResolution`): the resolved
/// app id plus the request path with the matched base_path stripped (still
/// starting with `/`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppResolution {
    /// The resolved app's id.
    pub app_id: String,
    /// The request path with the matched base_path removed. `"/"` when the path
    /// exactly equals a non-root base_path; the full path for the root app.
    pub relative_path: String,
}

/// A registered app's `{id, base_path, schema_id, schema_revision}` for
/// `GET /_frick/inspect/apps` (map 02 §4.5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppDescriptor {
    /// The app id.
    pub id: String,
    /// The app's mount prefix (`""` for the root app).
    pub base_path: String,
    /// The app schema's id.
    pub schema_id: String,
    /// The app schema's revision.
    pub schema_revision: i64,
}

/// The multi-app registry (`createFrickAppRegistry`). Holds apps in registration
/// order plus a longest-base_path-first index for [`resolve_by_path`].
///
/// [`resolve_by_path`]: FrickAppRegistry::resolve_by_path
pub struct FrickAppRegistry {
    /// Apps in registration order (drives `descriptors` / `find_by_schema_id`).
    apps: Vec<AppEntry>,
    /// Indices into `apps`, sorted longest-base_path-first, so `resolve_by_path`
    /// returns the most specific prefix and the `""` root app is the fallback.
    resolve_order: Vec<usize>,
}

impl FrickAppRegistry {
    /// Build a registry from already-constructed [`AppEntry`]s, validating the
    /// id / base_path invariants (`createFrickAppRegistry`):
    ///
    /// - every `base_path` is either `""` or starts with `/` and has no trailing
    ///   slash;
    /// - `base_path`s are unique (`""` permitted at most once — the root app);
    /// - ids are unique.
    ///
    /// # Errors
    /// Returns [`FrickConfigError`] (so boot surfaces it as a config failure)
    /// with the TS-faithful message on the first violation.
    pub fn new(apps: Vec<AppEntry>) -> Result<Self, FrickConfigError> {
        let mut seen_ids: Vec<&str> = Vec::with_capacity(apps.len());
        let mut seen_base_paths: Vec<&str> = Vec::with_capacity(apps.len());
        for app in &apps {
            if !app.base_path.is_empty()
                && (!app.base_path.starts_with('/') || app.base_path.ends_with('/'))
            {
                return Err(FrickConfigError(format!(
                    "App \"{}\" basePath must start with \"/\" and have no trailing slash (got {:?})",
                    app.id, app.base_path
                )));
            }
            if seen_base_paths.contains(&app.base_path.as_str()) {
                return Err(FrickConfigError(format!(
                    "Duplicate Frick app basePath {:?} (app id \"{}\")",
                    app.base_path, app.id
                )));
            }
            if seen_ids.contains(&app.id.as_str()) {
                return Err(FrickConfigError(format!(
                    "Duplicate Frick app id \"{}\"",
                    app.id
                )));
            }
            seen_ids.push(&app.id);
            seen_base_paths.push(&app.base_path);
        }

        // Longest-base_path-first ordering for resolution; ties keep registration
        // order (stable sort) so a deterministic app wins. The `""` root app has
        // length 0 and so sorts last — the universal fallback.
        let mut resolve_order: Vec<usize> = (0..apps.len()).collect();
        resolve_order.sort_by(|&a, &b| apps[b].base_path.len().cmp(&apps[a].base_path.len()));

        Ok(Self {
            apps,
            resolve_order,
        })
    }

    /// The number of registered apps.
    #[must_use]
    pub fn len(&self) -> usize {
        self.apps.len()
    }

    /// Whether the registry holds no apps (only true before construction; a
    /// real registry always holds at least the `_default`/root app).
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.apps.is_empty()
    }

    /// Whether this is a genuine multi-app server (`len() > 1`). The load-bearing
    /// switch: storage app-id resolution + the Hello `appNotAuthorized` rejection
    /// only diverge from single-app behavior when this is `true`.
    #[must_use]
    pub fn is_multi_app(&self) -> bool {
        self.apps.len() > 1
    }

    /// Look up an app by id (`get`).
    #[must_use]
    pub fn get(&self, app_id: &str) -> Option<&AppEntry> {
        self.apps.iter().find(|app| app.id == app_id)
    }

    /// Find the app whose schema id matches (`findBySchemaId`), used by
    /// Hello-driven WS routing. Registration order resolves any duplicate-id
    /// (impossible) tie; schema ids are not validated unique here (the TS does
    /// not either), so the first registered match wins.
    #[must_use]
    pub fn find_by_schema_id(&self, schema_id: &str) -> Option<&AppEntry> {
        self.apps
            .iter()
            .find(|app| app.schema.schema_id == schema_id)
    }

    /// Pick the app whose base_path is the longest prefix of `url_path`, and
    /// return its id + the path with that base_path stripped (`resolveByPath`).
    ///
    /// - A non-root app matches when `url_path == base_path` (relative `"/"`) or
    ///   `url_path` starts with `"<base_path>/"` (relative = the remainder,
    ///   still starting with `/`).
    /// - The `""` root app matches anything as the fallback (relative =
    ///   `url_path` unchanged), but only after every longer prefix failed
    ///   (resolution iterates longest-first).
    ///
    /// Returns `None` only when no app matches (possible only when there is no
    /// root app and `url_path` matches no prefix).
    #[must_use]
    pub fn resolve_by_path(&self, url_path: &str) -> Option<AppResolution> {
        for &index in &self.resolve_order {
            let app = &self.apps[index];
            if app.base_path.is_empty() {
                return Some(AppResolution {
                    app_id: app.id.clone(),
                    relative_path: url_path.to_string(),
                });
            }
            if url_path == app.base_path {
                return Some(AppResolution {
                    app_id: app.id.clone(),
                    relative_path: "/".to_string(),
                });
            }
            let with_slash = format!("{}/", app.base_path);
            if let Some(rest) = url_path.strip_prefix(&app.base_path)
                && url_path.starts_with(&with_slash)
            {
                return Some(AppResolution {
                    app_id: app.id.clone(),
                    relative_path: rest.to_string(),
                });
            }
        }
        None
    }

    /// The storage `app_id` for a request that resolved to `resolved`: the
    /// resolved app id on a genuine multi-app server, else always `_default`
    /// (`src/server.ts:1171-1172`; map 02 §7). This is the single rule that
    /// keeps single-app storage byte-for-byte identical.
    #[must_use]
    pub fn storage_app_id<'a>(&self, resolved: &'a str) -> &'a str {
        if self.is_multi_app() {
            resolved
        } else {
            DEFAULT_APP_ID
        }
    }

    /// The storage key for a search index, partitioned by app on a multi-app
    /// server. The `search_indexes` FTS rows are keyed by `(tenant, index_name,
    /// doc_id)` with no `app_id` column, so two apps that register the SAME
    /// index name on one tenant would otherwise co-mingle their documents (and
    /// defeat the per-hit/admin authz post-filter). Namespacing the stored index
    /// name by the app's storage id partitions them. Single-app keeps the raw
    /// registered name (the U+001F separator never appears in an index name), so
    /// behavior + stored rows stay byte-identical. `app_id` must already be the
    /// storage app id (i.e. [`Self::storage_app_id`]).
    #[must_use]
    pub fn scoped_index_name(&self, app_id: &str, index_name: &str) -> String {
        if self.is_multi_app() {
            format!("{app_id}\u{1f}{index_name}")
        } else {
            index_name.to_string()
        }
    }

    /// The `{id, base_path, schema_id, schema_revision}` descriptors for
    /// `GET /_frick/inspect/apps`, in registration order.
    #[must_use]
    pub fn descriptors(&self) -> Vec<AppDescriptor> {
        self.apps
            .iter()
            .map(|app| AppDescriptor {
                id: app.id.clone(),
                base_path: app.base_path.clone(),
                schema_id: app.schema.schema_id.clone(),
                schema_revision: app.schema.schema_revision,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A schema whose only varied fields are `schema_id` / `schema_revision`
    /// (everything else is the foundation schema's).
    fn schema_with_id(schema_id: &str, revision: i64) -> FrickSchema {
        let mut schema = frick_protocol::foundation_schema();
        schema.schema_id = schema_id.to_string();
        schema.schema_revision = revision;
        schema
    }

    fn entry(id: &str, base_path: &str, schema_id: &str) -> AppEntry {
        AppEntry {
            id: id.to_string(),
            base_path: base_path.to_string(),
            schema: schema_with_id(schema_id, 1),
            projections: ProjectionRegistry::new(),
            search: SearchRegistry::new(),
        }
    }

    fn default_only() -> FrickAppRegistry {
        FrickAppRegistry::new(vec![entry(DEFAULT_APP_ID, "", "frick.foundation")]).unwrap()
    }

    #[test]
    fn single_default_app_is_not_multi_app() {
        let registry = default_only();
        assert_eq!(registry.len(), 1);
        assert!(!registry.is_multi_app());
        assert!(!registry.is_empty());
    }

    #[test]
    fn storage_app_id_pins_default_for_single_app() {
        let registry = default_only();
        // Even if a caller hands a non-default resolved id, a single-app server
        // pins `_default` — the load-bearing backward-compat rule.
        assert_eq!(registry.storage_app_id("chat"), DEFAULT_APP_ID);
        assert_eq!(registry.storage_app_id(DEFAULT_APP_ID), DEFAULT_APP_ID);
    }

    #[test]
    fn scoped_index_name_partitions_only_multi_app() {
        // Single-app: identity, so stored FTS rows stay byte-identical.
        let single = default_only();
        assert_eq!(single.scoped_index_name(DEFAULT_APP_ID, "posts"), "posts");

        // Multi-app: two apps' same-named index map to DISTINCT storage keys,
        // so their FTS documents never co-mingle (FR-277 search isolation).
        let multi = FrickAppRegistry::new(vec![
            entry("app-a", "/a", "schema.a"),
            entry("app-b", "/b", "schema.b"),
        ])
        .unwrap();
        let a = multi.scoped_index_name("app-a", "posts");
        let b = multi.scoped_index_name("app-b", "posts");
        assert_ne!(
            a, b,
            "same index name, different apps ⇒ distinct storage keys"
        );
        assert_eq!(a, "app-a\u{1f}posts");
        assert_eq!(b, "app-b\u{1f}posts");
    }

    #[test]
    fn storage_app_id_uses_resolved_for_multi_app() {
        let registry = FrickAppRegistry::new(vec![
            entry("root", "", "frick.foundation"),
            entry("chat", "/chat", "chat.schema"),
        ])
        .unwrap();
        assert!(registry.is_multi_app());
        assert_eq!(registry.storage_app_id("chat"), "chat");
        assert_eq!(registry.storage_app_id("root"), "root");
    }

    #[test]
    fn resolve_by_path_longest_prefix_wins() {
        let registry = FrickAppRegistry::new(vec![
            entry("root", "", "frick.foundation"),
            entry("chat", "/chat", "chat.schema"),
            entry("chat-admin", "/chat/admin", "chat.admin.schema"),
        ])
        .unwrap();

        // `/chat/admin/x` matches `/chat/admin`, not the shorter `/chat`.
        let resolution = registry.resolve_by_path("/chat/admin/x").unwrap();
        assert_eq!(resolution.app_id, "chat-admin");
        assert_eq!(resolution.relative_path, "/x");

        // `/chat/rooms` matches `/chat` (the `/admin` prefix needs a `/admin/`
        // or exact `/admin` boundary).
        let resolution = registry.resolve_by_path("/chat/rooms").unwrap();
        assert_eq!(resolution.app_id, "chat");
        assert_eq!(resolution.relative_path, "/rooms");
    }

    #[test]
    fn resolve_by_path_exact_base_path_yields_root_relative() {
        let registry = FrickAppRegistry::new(vec![
            entry("root", "", "frick.foundation"),
            entry("chat", "/chat", "chat.schema"),
        ])
        .unwrap();
        let resolution = registry.resolve_by_path("/chat").unwrap();
        assert_eq!(resolution.app_id, "chat");
        assert_eq!(resolution.relative_path, "/");
    }

    #[test]
    fn resolve_by_path_prefix_boundary_is_respected() {
        // `/chatter` must NOT match the `/chat` app (no `/` boundary). With a
        // root app it falls through to root; without one it is unresolved.
        let registry = FrickAppRegistry::new(vec![
            entry("root", "", "frick.foundation"),
            entry("chat", "/chat", "chat.schema"),
        ])
        .unwrap();
        let resolution = registry.resolve_by_path("/chatter").unwrap();
        assert_eq!(resolution.app_id, "root");
        assert_eq!(resolution.relative_path, "/chatter");

        let no_root = FrickAppRegistry::new(vec![entry("chat", "/chat", "chat.schema")]).unwrap();
        assert!(no_root.resolve_by_path("/chatter").is_none());
    }

    #[test]
    fn resolve_by_path_root_app_matches_anything_as_fallback() {
        let registry = FrickAppRegistry::new(vec![
            entry("root", "", "frick.foundation"),
            entry("chat", "/chat", "chat.schema"),
        ])
        .unwrap();
        let resolution = registry.resolve_by_path("/anything/else").unwrap();
        assert_eq!(resolution.app_id, "root");
        assert_eq!(resolution.relative_path, "/anything/else");
    }

    #[test]
    fn find_by_schema_id_matches_registered_app() {
        let registry = FrickAppRegistry::new(vec![
            entry("root", "", "frick.foundation"),
            entry("chat", "/chat", "chat.schema"),
        ])
        .unwrap();
        assert_eq!(
            registry
                .find_by_schema_id("chat.schema")
                .map(|a| a.id.as_str()),
            Some("chat")
        );
        assert!(registry.find_by_schema_id("nope.schema").is_none());
    }

    #[test]
    fn get_resolves_by_id() {
        let registry = default_only();
        assert!(registry.get(DEFAULT_APP_ID).is_some());
        assert!(registry.get("missing").is_none());
    }

    #[test]
    fn descriptors_are_registration_ordered() {
        let registry = FrickAppRegistry::new(vec![
            entry("root", "", "frick.foundation"),
            entry("chat", "/chat", "chat.schema"),
        ])
        .unwrap();
        let descriptors = registry.descriptors();
        assert_eq!(descriptors.len(), 2);
        assert_eq!(descriptors[0].id, "root");
        assert_eq!(descriptors[0].base_path, "");
        assert_eq!(descriptors[0].schema_id, "frick.foundation");
        assert_eq!(descriptors[1].id, "chat");
        assert_eq!(descriptors[1].base_path, "/chat");
    }

    /// Extract the config error from a registry construction expected to fail.
    /// (`FrickAppRegistry` holds non-`Debug` registries, so `unwrap_err` is
    /// unavailable; this discards the `Ok` value without printing it.)
    fn expect_err(result: Result<FrickAppRegistry, FrickConfigError>) -> FrickConfigError {
        match result {
            Ok(_) => panic!("expected a FrickConfigError, got a valid registry"),
            Err(error) => error,
        }
    }

    #[test]
    fn rejects_base_path_without_leading_slash() {
        let error = expect_err(FrickAppRegistry::new(vec![entry(
            "chat",
            "chat",
            "chat.schema",
        )]));
        assert!(error.to_string().contains("must start with"), "got {error}");
    }

    #[test]
    fn rejects_base_path_with_trailing_slash() {
        let error = expect_err(FrickAppRegistry::new(vec![entry(
            "chat",
            "/chat/",
            "chat.schema",
        )]));
        assert!(
            error.to_string().contains("no trailing slash"),
            "got {error}"
        );
    }

    #[test]
    fn rejects_duplicate_base_path() {
        let error = expect_err(FrickAppRegistry::new(vec![
            entry("a", "/x", "a.schema"),
            entry("b", "/x", "b.schema"),
        ]));
        assert!(error.to_string().contains("Duplicate"), "got {error}");
        assert!(error.to_string().contains("basePath"), "got {error}");
    }

    #[test]
    fn rejects_duplicate_empty_base_path() {
        // `""` is allowed once; a second root app is a duplicate.
        let error = expect_err(FrickAppRegistry::new(vec![
            entry("a", "", "a.schema"),
            entry("b", "", "b.schema"),
        ]));
        assert!(error.to_string().contains("Duplicate"), "got {error}");
    }

    #[test]
    fn rejects_duplicate_id() {
        let error = expect_err(FrickAppRegistry::new(vec![
            entry("dup", "/a", "a.schema"),
            entry("dup", "/b", "b.schema"),
        ]));
        assert!(error.to_string().contains("Duplicate"), "got {error}");
        assert!(error.to_string().contains("id"), "got {error}");
    }

    #[test]
    fn empty_base_path_allowed_once() {
        // A single root app with `""` is valid.
        let registry = FrickAppRegistry::new(vec![entry("root", "", "frick.foundation")]).unwrap();
        assert_eq!(registry.len(), 1);
    }
}
