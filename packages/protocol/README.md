# @fricken/protocol

Canonical wire-protocol types, msgpack codecs, schema metadata, and generated artifact helpers for the Frick framework.

This package is the source of truth for the wire contract every Frick client and server speaks. It exports:

- `FrickSchema`, `validateSchema`, `foundationSchema`
- `FrameKind` enum and `FrickFrame` discriminated union
- `FrickErrorEnvelope`, `createFrickErrorEnvelope`, `isFrickErrorEnvelope`
- `FrickClientCapabilities`, `FrickServerCapabilities`, capability helpers
- `compareSchemaCompatibility`, `requireSchemaCompatibility`
- Schema linter (`lintSchema`, `lintSchemaChange`)
- Native-artifact generator entry points for Swift and Kotlin
- Reference fixtures under `fixtures/` used by every SDK's conformance suite

See [`docs/versioning.md`](../../docs/versioning.md) for compatibility rules and [`docs/cross-platform-client-contract.md`](../../docs/cross-platform-client-contract.md) for what every client must honor.

## Install

```sh
pnpm add @fricken/protocol
```

## License

See repository root.
