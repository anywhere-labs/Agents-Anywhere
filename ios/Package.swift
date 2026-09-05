// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "AgentsAnywhereClient",
    platforms: [.macOS(.v15), .iOS("26.5")],
    targets: [
        .target(
            name: "ClientCore",
            path: "Agents Anywhere/Agents Anywhere",
            exclude: [
                "App", "Assets.xcassets", "Resources", "Services", "Stores", "Views",
                "ios-dark.icon", "Business/AccountAvatarProcessor.swift",
            ],
            sources: ["API", "Network", "Models", "Domain", "Business", "Repositories"],
            swiftSettings: [.defaultIsolation(MainActor.self)]
        ),
        .testTarget(
            name: "ClientCoreTests",
            dependencies: ["ClientCore"],
            path: "Tests/ClientCoreTests",
            resources: [.copy("Fixtures")],
            swiftSettings: [.defaultIsolation(MainActor.self)]
        ),
    ],
    swiftLanguageModes: [.v5]
)
