import AAClientCore
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingSignOut = false
    @State private var forgetting: DeviceTrustRecord?
    @State private var pairing = false

    var body: some View {
        NavigationStack {
            Form {
                if let account = model.account {
                    Section("账号") {
                        LabeledContent("名称", value: account.user.displayName)
                        if let email = account.user.email { LabeledContent("邮箱", value: email) }
                        LabeledContent("控制面", value: account.controlURL)
                    }
                }

                Section {
                    LabeledContent("本机公钥指纹") {
                        Text(clientFingerprint).font(.caption.monospaced())
                    }
                    let records = model.trustRecords()
                    if records.isEmpty {
                        Text("还没有配对加密设备").foregroundStyle(.secondary)
                    }
                    ForEach(records, id: \.deviceID) { record in
                        HStack {
                            Image(systemName: "lock.fill").foregroundStyle(.green)
                            VStack(alignment: .leading) {
                                Text(model.device(record.deviceID)?.name ?? record.deviceNameHint ?? record.deviceID)
                                Text(KeyFingerprint.format(record.devicePub)).font(.caption2.monospaced()).foregroundStyle(.secondary)
                            }
                        }
                        .swipeActions {
                            Button("移除", role: .destructive) { forgetting = record }
                        }
                    }
                    Button { pairing = true } label: {
                        Label("配对加密设备", systemImage: "qrcode.viewfinder")
                    }
                } header: {
                    Text("端到端加密")
                } footer: {
                    Text("本机的私钥只保存在这台设备的钥匙串里。加密设备的公钥只来自它显示的二维码；移除后需要重新扫码才能再连接。")
                }

                Section("外观") {
                    LabeledContent("配色", value: "跟随系统")
                    Text("界面使用系统材质和配色，并遵循「减弱透明度」「增强对比度」等辅助功能设置。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("关于") {
                    LabeledContent("版本", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—")
                    LabeledContent("渲染包", value: RenderBridge.bundleURL?.lastPathComponent == "aa-render.html" ? "web-v3" : "内置占位")
                }

                Section {
                    Button("退出登录", role: .destructive) { confirmingSignOut = true }
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
            }
            .sheet(isPresented: $pairing) { PairingView(expectedDeviceID: nil) }
            .confirmationDialog("退出登录？", isPresented: $confirmingSignOut, titleVisibility: .visible) {
                Button("退出登录", role: .destructive) {
                    dismiss()
                    Task { await model.signOut() }
                }
            } message: {
                Text("已配对设备的信任记录和本机密钥会保留，重新登录同一账号后无需重新配对。")
            }
            .confirmationDialog(
                "移除这台设备的信任记录？", isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }),
                titleVisibility: .visible
            ) {
                Button("移除", role: .destructive) {
                    guard let record = forgetting, let services = model.services else { return }
                    Task {
                        try? await services.tunnels.forget(record.deviceID)
                        model.trustChanged()
                    }
                }
            } message: {
                Text("之后要重新扫描设备上的配对二维码才能连接它。")
            }
        }
    }

    private var clientFingerprint: String {
        guard let key = try? model.services?.identity.publicKey() else { return "—" }
        return KeyFingerprint.format(key)
    }
}
