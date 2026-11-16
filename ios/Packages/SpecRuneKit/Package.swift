// swift-tools-version: 6.2

import PackageDescription

// SpecRune 看板的数据层。
//
// 刻意零依赖：只放契约 DTO、取数流程、JSON 解析、错误分类。传输由宿主
// （主 app）实现 `SpecRuneTransport` 注入——这样本包不依赖 ClientCore，
// 也就不必为了跨包可见性给一堆既有类型加 `public`。
//
// UI 留在主 app 的 Views/SpecRune，以便复用 AppTheme / AppSymbol
// （它们在主 app 的 Views 下，不在 ClientCore target 内）。
let package = Package(
    name: "SpecRuneKit",
    platforms: [.macOS(.v15), .iOS("26.3")],
    products: [
        .library(name: "SpecRuneKit", targets: ["SpecRuneKit"])
    ],
    targets: [
        .target(
            name: "SpecRuneKit",
            swiftSettings: [.defaultIsolation(MainActor.self)]
        ),
        .testTarget(
            name: "SpecRuneKitTests",
            dependencies: ["SpecRuneKit"],
            swiftSettings: [.defaultIsolation(MainActor.self)]
        )
    ],
    swiftLanguageModes: [.v5]
)
