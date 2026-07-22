// swift-tools-version: 6.0

import CompilerPluginSupport
import PackageDescription

let package = Package(
    name: "FrickSwift",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
        .visionOS(.v2),
        .watchOS(.v10),
    ],
    products: [
        .library(name: "FrickSwift", targets: ["FrickSwift"]),
    ],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-syntax.git", "509.0.0" ..< "605.0.0-a"),
    ],
    targets: [
        // The compiler plugin that implements `@FrickModel`. Builds for the
        // host toolchain only; it is never linked into the app binary, and its
        // swift-syntax dependency stays host-only — which is why consumers don't
        // need to grant CI access to swift-syntax and it isn't built per-platform.
        .macro(
            name: "FrickMacros",
            dependencies: [
                .product(name: "SwiftSyntaxMacros", package: "swift-syntax"),
                .product(name: "SwiftCompilerPlugin", package: "swift-syntax"),
            ]
        ),
        // FrickSwift owns the @FrickModel macro DECLARATION (FrickModelMacro.swift)
        // and depends on the FrickMacros plugin directly, so `import FrickSwift`
        // exposes the macro. This keeps the macro internal (the 0.8.x shape) rather
        // than a separate FrickSwiftMacros product the app links — which had pulled
        // swift-syntax into every per-platform app build + Xcode Cloud's repo graph.
        .target(
            name: "FrickSwift",
            dependencies: ["FrickMacros"],
            linkerSettings: [
                .linkedLibrary("sqlite3"),
            ]
        ),
        .testTarget(
            name: "FrickSwiftTests",
            dependencies: ["FrickSwift"]
        ),
        .testTarget(
            name: "FrickMacrosTests",
            dependencies: [
                "FrickMacros",
                .product(name: "SwiftSyntaxMacrosTestSupport", package: "swift-syntax"),
            ]
        ),
    ]
)
