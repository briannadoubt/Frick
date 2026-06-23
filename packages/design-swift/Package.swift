// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "FrickDesign",
    platforms: [
        // iOS lowered to 17 to match FrickSwift so downstream apps aren't forced
        // to iOS 18 by the design kit. The one iOS-18 API (`.sidebarAdaptable`)
        // is guarded with `if #available`. macOS stays 15 — `.sidebarAdaptable`
        // ships there at 15 and the desktop app already targets 15.
        .iOS(.v17),
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
