// swift-tools-version: 6.0

import CompilerPluginSupport
import PackageDescription

let package = Package(
    name: "FrickSwift",
    platforms: [
        .iOS(.v18),
        .macOS(.v15),
    ],
    products: [
        .library(name: "FrickSwift", targets: ["FrickSwift"]),
    ],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-syntax.git", "509.0.0" ..< "603.0.0"),
    ],
    targets: [
        // The compiler plugin that implements `@FrickModel`. Builds for the
        // host toolchain only; it is never linked into the app binary.
        .macro(
            name: "FrickMacros",
            dependencies: [
                .product(name: "SwiftSyntaxMacros", package: "swift-syntax"),
                .product(name: "SwiftCompilerPlugin", package: "swift-syntax"),
            ]
        ),
        .target(
            name: "FrickSwift",
            dependencies: ["FrickMacros"],
            linkerSettings: [
                .linkedLibrary("sqlite3"),
            ]
        ),
        .testTarget(name: "FrickSwiftTests", dependencies: ["FrickSwift"]),
        .testTarget(
            name: "FrickMacrosTests",
            dependencies: [
                "FrickMacros",
                .product(name: "SwiftSyntaxMacrosTestSupport", package: "swift-syntax"),
            ]
        ),
    ]
)
