// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "FrickDesign",
    platforms: [
        // Match FrickSwift's floors (iOS 17 / macOS 14). The one newer API,
        // `.sidebarAdaptable` (iOS 18 / macOS 15), is guarded with `if #available`.
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "FrickDesign", targets: ["FrickDesign"]),
    ],
    targets: [
        .target(name: "FrickDesign"),
        .testTarget(name: "FrickDesignTests", dependencies: ["FrickDesign"]),
    ]
)
