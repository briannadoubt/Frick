//! Frick schema authoring in Rust (FR-239).
//!
//! The canonical AST lives in [`frick_protocol::schema`]; this crate layers
//! the authoring surface on top:
//!
//! - [`builder`] — the fluent DSL apps use to declare schemas (the Rust
//!   counterpart of writing `schema.ts`), validating on build.
//! - [`lint`] — the breaking-change linter: single-snapshot validity checks
//!   plus current-vs-previous diff findings with stable rule ids, ported
//!   rule-for-rule from `packages/protocol/src/lint.ts` and pinned by golden
//!   fixtures under `conformance/fixtures/lint/`.
//!
//! Schema identity (`hash`, `schemaRevision`) is carried, never computed —
//! see the `frick_protocol::schema` module docs.

pub mod builder;
pub mod lint;

pub use builder::SchemaBuilder;
pub use lint::{
    FrickLintFinding, FrickLintResult, FrickLintSeverity, lint_schema, lint_schema_change,
};
