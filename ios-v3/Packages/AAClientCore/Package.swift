// swift-tools-version:6.0
import PackageDescription

// AAClientCore: everything the AA v3 iOS/iPadOS app does that is not UI — control-plane HTTP, the MeshCall
// control client, the device tunnel pool (normal and end-to-end), Keychain storage, the offline cache and the
// native side of the `aa.render/2` WebView bridge. Kept in a package so `swift test` covers it on macOS.
//
// MeshCall is a local path dependency: run `scripts/bootstrap.sh` first (see ios-v3/README.md).
let package = Package(
    name: "AAClientCore",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "AAClientCore", targets: ["AAClientCore"]),
    ],
    dependencies: [
        .package(path: "../../Vendor/meshcall-swift"),
    ],
    targets: [
        .target(
            name: "AAClientCore",
            dependencies: [.product(name: "MeshCall", package: "meshcall-swift")]
        ),
        .testTarget(
            name: "AAClientCoreTests",
            dependencies: ["AAClientCore"]
        ),
    ]
)
