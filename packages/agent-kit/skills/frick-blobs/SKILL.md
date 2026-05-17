---
name: frick-blobs
description: Use when adding blob storage, upload flows, content-addressed binary data, blob limits, or blob-related client behavior in a Frick app.
---

# Frick Blobs

Read `docs/cross-platform-client-contract.md` and `docs/operations.md`.

Blob guidance:
- Model blob references in the schema and document upload ownership in the spine.
- Respect server limits for size and content type.
- Surface `blob.tooLarge` and `blob.unsupportedContentType` through the structured error envelope.
- Keep binary transfer code out of demo-only paths when building reusable app behavior.

Verify server errors and client retry behavior with tests on the touched platform.
