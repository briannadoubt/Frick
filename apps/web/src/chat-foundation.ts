/**
 * Re-export shim for the helpers that graduated into `@frick/core/chat` as
 * part of Phase 1c of the cohesive SDK refactor. The new home is
 * `packages/core/src/chat.ts`. This file exists only so the web app's
 * existing imports keep working through the migration; it'll be deleted in
 * Phase 3 when the web demo migrates to the React-layer helpers
 * (`useSearch`, `<FileDropzone>`, `useSession` / `<RequireAuth>`).
 */
export * from "@frick/core/chat";
