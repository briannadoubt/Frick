//! Frick schema code generation (FR-240): Swift, Kotlin, and TypeScript DTO
//! generators consuming the canonical AST, ported from
//! `packages/protocol/src/artifacts.ts` and `packages/protocol/src/generators/`.
//! Output must be byte-identical to `pnpm schema:generate` for the same
//! schema — pinned by snapshot tests against the committed artifacts.

pub mod error_enums;
pub mod kotlin;
pub mod swift;
pub mod typescript;
