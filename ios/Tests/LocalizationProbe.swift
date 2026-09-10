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
    expect(String(localized: "运行目标", bundle: bundle, locale: locale), chinese ? "设备和 Agent" : "Device and agent")
    expect(String(localized: "思考强度", bundle: bundle, locale: locale), chinese ? "推理强度" : "Reasoning effort")
    expect(String(localized: "Restore", bundle: bundle, locale: locale), chinese ? "取消归档" : "Unarchive")
    expect(String(localized: "dashboard.new.typewriter.buildNext", bundle: bundle, locale: locale),
           chinese ? "接下来要构建什么？" : "What should we build next?")
    expect(String(localized: "dashboard.pairDevice.codeLabel", bundle: bundle, locale: locale),
           chinese ? "设备上的配对码" : "Pair code from device")
    let label = String(localized: "dashboard.device.runtimeConfigFields.useSystemCodex.label", bundle: bundle, locale: locale)
    precondition(!label.hasPrefix("dashboard."), "Runtime metadata key was shown without a translation")
    checks += 1
    let runtimeName = "Work Agent"
    expect(String(localized: "\(runtimeName) will be stopped and removed from the configured list. All associated sessions, message history, and attachments will be permanently deleted. You can configure the runtime again later; the local installation is kept.", bundle: bundle, locale: locale),
           chinese ? "Work Agent 会停止并从已配置列表移除，其关联的所有会话、消息记录和附件将被永久删除。之后仍可重新配置 Runtime，本机安装会保留。" : "Work Agent will be stopped and removed from the configured list. All associated sessions, message history, and attachments will be permanently deleted. You can configure the runtime again later; the local installation is kept.")
    for (mode, english, simplifiedChinese) in [
        ("readOnly", "read-only", "仅可查看"),
        ("workspaceWrite", "workspace-write", "工作区内修改"),
        ("fullAccess", "danger-full-access", "完全权限"),
    ] {
        expect(bundle.localizedString(forKey: "dashboard.new.permissionModes.dsh.\(mode).label", value: nil, table: nil),
               chinese ? simplifiedChinese : english)
    }
    for count in [0, 1, 2] {
        expect(String(localized: "\(count) projects", bundle: bundle, locale: locale),
               chinese ? "\(count) 个项目" : "\(count) \(count == 1 ? "project" : "projects")")
        expect(String(localized: "\(count) 次工具调用", bundle: bundle, locale: locale),
               chinese ? "\(count) 次工具调用" : "\(count) tool \(count == 1 ? "call" : "calls")")
        expect(String(localized: "\(count) sessions", bundle: bundle, locale: locale),
               chinese ? "\(count) 个会话" : "\(count) \(count == 1 ? "session" : "sessions")")
        expect(String(localized: "\(count) selected", bundle: bundle, locale: locale),
               chinese ? "已选择 \(count) 个" : "\(count) selected")
    }
    let seconds = 30
    expect(String(localized: "Resend in \(seconds) s", bundle: bundle, locale: locale),
           chinese ? "30 秒后重发" : "Resend in 30s")
    let path = "/work", currentName = "Project A", newName = "Project B"
    expect(String(localized: "The workspace “\(path)” already belongs to “\(currentName)”. Continuing will rename that project to “\(newName)” instead of creating a duplicate. Its sessions and settings will be preserved.", bundle: bundle, locale: locale),
           chinese ? "工作目录“/work”已属于项目“Project A”。继续后不会创建新项目，而会把现有项目重命名为“Project B”；项目内的会话和设置都会保留。" : "The workspace “/work” already belongs to “Project A”. Continuing will rename that project to “Project B” instead of creating a duplicate. Its sessions and settings will be preserved.")
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
