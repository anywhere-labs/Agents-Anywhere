import Foundation

// Standalone probe for the actual compiled catalogs. No UI or simulator.
// swift ios/Tests/LocalizationProbe.swift /path/to/compiled-localization.bundle
guard CommandLine.arguments.count == 2 else {
    fatalError("Pass the bundle directory containing compiled en.lproj and zh-Hans.lproj")
}
let root = URL(fileURLWithPath: CommandLine.arguments[1])
var checks = 0
func expect(_ actual: String, _ expected: String) {
    precondition(actual == expected, "Expected \(expected.debugDescription), received \(actual.debugDescription)")
    checks += 1
}
for language in ["en", "zh-Hans"] {
    let bundle = Bundle(url: root.appendingPathComponent("\(language).lproj"))!
    let locale = Locale(identifier: language)
    let chinese = language == "zh-Hans"
    expect(String(localized: "Settings", bundle: bundle, locale: locale), chinese ? "设置" : "Settings")
    expect(String(localized: "Close", bundle: bundle, locale: locale), chinese ? "关闭" : "Close")
    let label = String(localized: "dashboard.device.runtimeConfigFields.useSystemCodex.label", bundle: bundle, locale: locale)
    precondition(!label.hasPrefix("dashboard."), "Runtime metadata key was shown without a translation")
    checks += 1
    for count in [0, 1, 2] {
        expect(String(localized: "\(count) projects", bundle: bundle, locale: locale),
               chinese ? "\(count) 个项目" : "\(count) \(count == 1 ? "project" : "projects")")
        expect(String(localized: "\(count) 次工具调用", bundle: bundle, locale: locale),
               chinese ? "\(count) 次工具调用" : "\(count) tool \(count == 1 ? "call" : "calls")")
    }
    let name = "apiKey", location = "modelGateway"
    expect(String(localized: "Missing '\(name)' in \(location).", bundle: bundle, locale: locale),
           chinese ? "在 modelGateway 中缺少“apiKey”。" : "Missing 'apiKey' in modelGateway.")
    for key in ["NSCameraUsageDescription", "NSLocalNetworkUsageDescription"] {
        let message = bundle.localizedString(forKey: key, value: nil, table: "InfoPlist")
        precondition(message != key && !message.isEmpty, "Missing permission description: \(language) \(key)")
        checks += 1
    }
}
print("Passed \(checks) compiled localization checks.")
