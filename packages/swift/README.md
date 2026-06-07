# FrickSwift

Swift client for Frick (sync socket, client, SwiftUI streaming, push payloads).

## Runtime notes

- Product-schema apps should construct `FrickClient` with the app
  `schemaId`, `schemaRevision`, `schemaHash`, and `FrickSchemaDescriptor`.
  The identity feeds HTTP schema guards and sync Hello; the descriptor lets the
  socket decode packed Snapshot/Delta frames whose type and field ids come from
  the product schema rather than the foundation schema.
- `FrickSyncSocket` buffers frames issued immediately after `connect()` until
  the WebSocket opens, replays active subscriptions after reconnect, and
  decodes packed object/stream frames through the configured schema descriptor.
- `FrickClient.fetchObjects` decodes response rows individually and skips
  malformed rows with a log notice instead of failing the entire fetch.
- `FrickClient` defaults to `FrickKeychainSessionStore`, auto-restores a
  saved unexpired session during initialization, persists sessions installed
  through Frick auth calls or `restoreSession(_:)`, and clears the persisted
  session on `logout()`. Tests and previews can inject
  `FrickInMemorySessionStore`.
- `FrickClient.writeObject(... expectedVersion: nil)` looks up the locally
  cached object version and sends it as `if-match` when available, so schemas
  using `versionPrecondition` can update rows after a prior fetch/write without
  app code passing the version manually. Explicit `expectedVersion` values
  still win, and stale local versions still surface as server conflicts.

## Consuming this package

This package is developed here, inside the [Frick monorepo](https://github.com/briannadoubt/Frick)
at `packages/swift/`. Because SwiftPM cannot resolve a package nested in a
subdirectory of a repo, it is **published** (subtree-mirrored, with history) to
a standalone repo whose root is this package:

> **https://github.com/briannadoubt/FrickSwift**

Depend on the published mirror, not on a local checkout of this monorepo:

```swift
.package(url: "https://github.com/briannadoubt/FrickSwift.git", from: "0.1.0")
```

In an Xcode project, add it as a remote Swift Package
(`XCRemoteSwiftPackageReference`) pointing at the same URL.

## Releasing

The mirror is publish-only — never edit it by hand. To cut a release, tag a
commit on `main` and push the tag:

```sh
git tag swift-v0.2.0
git push origin swift-v0.2.0
```

`.github/workflows/publish-swift.yml` then builds the package and mirrors this
subtree to `FrickSwift` (`main` + a matching `0.2.0` tag) via
`scripts/publish-swift.sh`. This parallels the npm (`framework-v*`) and Android
(`android-v*`) release flows.
