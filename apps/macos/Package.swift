// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "TiboTattle",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "TiboTattle", targets: ["TiboTattle"]),
        .library(name: "TiboTattleCore", targets: ["TiboTattleCore"]),
    ],
    targets: [
        .target(
            name: "TiboTattleCore",
            path: "Sources/TiboTattleCore",
            linkerSettings: [.linkedLibrary("sqlite3")]
        ),
        .executableTarget(
            name: "TiboTattle",
            dependencies: ["TiboTattleCore"],
            path: "Sources/TiboTattle"
        ),
        .testTarget(
            name: "TiboTattleCoreTests",
            dependencies: ["TiboTattleCore"],
            path: "Tests/TiboTattleCoreTests"
        ),
    ]
)
