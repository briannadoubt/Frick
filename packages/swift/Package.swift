// swift-tools-version: 6.0

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
    targets: [
        .target(
            name: "FrickSwift",
            linkerSettings: [
                .linkedLibrary("sqlite3"),
            ]
        ),
        .testTarget(name: "FrickSwiftTests", dependencies: ["FrickSwift"]),
    ]
)
