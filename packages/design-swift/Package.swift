// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "FrickDesign",
    platforms: [
        .iOS(.v18),
        .macOS(.v15),
    ],
    products: [
        .library(name: "FrickDesign", targets: ["FrickDesign"]),
    ],
    targets: [
        .target(name: "FrickDesign"),
        .testTarget(name: "FrickDesignTests", dependencies: ["FrickDesign"]),
    ]
)
