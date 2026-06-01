# FrickSwift

Swift client for Frick (sync socket, client, SwiftUI streaming, push payloads).

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
