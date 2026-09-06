import SwiftUI
import UIKit

struct PairDeviceSheet: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var method: Method?
    @State private var name = "New device"
    @State private var code = ""
    @State private var credential: V2ConnectorCreateResponse?
    @State private var isWorking = false
    @State private var creationUncertain = false
    @State private var error: String?
    @State private var copied = false
    private enum Method { case desktop, cli }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if let method {
                        if method == .desktop { desktopInstructions } else { cliInstructions }
                    } else {
                        Text("选择设备的连接方式").font(.title2.bold())
                        AppGlassButton("桌面应用", systemImage: "desktopcomputer", prominent: true) { method = .desktop }
                        Text("在电脑上安装桌面应用，并登录同一账号。设备会自动显示在侧栏。").foregroundStyle(.secondary)
                        AppGlassButton("命令行", systemImage: "terminal") { method = .cli }
                        Text("适合通过 CLI 连接远程主机或无界面的设备。").foregroundStyle(.secondary)
                    }
                    if let error { Text(error).font(.footnote).foregroundStyle(.red) }
                }.padding(22).frame(maxWidth: 560)
            }.frame(maxWidth: .infinity)
            .navigationTitle("添加设备")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if method != nil && credential == nil {
                        Button("返回") { method = nil; error = nil }.disabled(isWorking)
                    }
                }
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() }.disabled(isWorking) }
            }
            .interactiveDismissDisabled(isWorking)
        }
    }

    private var desktopInstructions: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label("Agents Anywhere Desktop", systemImage: "desktopcomputer").font(.title2.bold())
            Text("在电脑上安装桌面应用，使用以下服务器地址登录当前账号。连接后，可以在设备管理中添加 Agent。")
            Text(appState.serverURL?.absoluteString ?? "").font(.callout.monospaced()).textSelection(.enabled)
            Link("下载桌面应用", destination: URL(string: "https://github.com/anywhere-labs/Agents-Anywhere/releases/latest")!)
                .buttonStyle(.glassProminent)
        }
    }

    @ViewBuilder private var cliInstructions: some View {
        if let credential, let server = appState.serverURL {
            Text(credential.connector.name).font(.title2.bold())
            Text("在目标设备运行以下命令，然后保持 CLI 运行。即使关闭此页面，我们也会继续等待设备连接。").foregroundStyle(.secondary)
            let command = V2PairingCommand.start(server: server, credential: credential)
            Text(command).font(.footnote.monospaced()).textSelection(.enabled)
                .padding(16).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
            AppGlassButton(copied ? "已复制" : "复制命令", systemImage: copied ? "checkmark" : "doc.on.doc") {
                UIPasteboard.general.string = command; copied = true
            }
            Text("命令包含设备凭据，请仅在你信任的设备上使用。").font(.footnote).foregroundStyle(.secondary)
            DisclosureGroup("使用六位配对码") {
                VStack(alignment: .leading, spacing: 14) {
                    Text("也可以先在目标设备运行以下命令，再填写 CLI 显示的配对码。").font(.footnote)
                    Text(V2PairingCommand.pair(server: server)).font(.footnote.monospaced()).textSelection(.enabled)
                    TextField("000000", text: $code).keyboardType(.numberPad).textContentType(.oneTimeCode)
                        .font(.title2.monospaced()).textFieldStyle(.roundedBorder)
                        .onChange(of: code) { _, value in code = String(value.filter { $0.isASCII && $0.isNumber }.prefix(6)) }
                    AppGlassButton("连接设备", systemImage: "link", isLoading: isWorking, prominent: true) {
                        Task { await claim(credential) }
                    }.disabled(code.count != 6 || isWorking || !canConnect)
                }.padding(.top, 12)
            }
            if let request = appState.nativeChatServices?.agentSetup.requests.first(where: { $0.id == credential.connector.id }) {
                HStack {
                    if request.ready { Image(systemName: "checkmark.circle") } else { ProgressView() }
                    Text(request.ready ? "设备已连接，关闭此页后可添加 Agent" : "等待设备连接…")
                }.font(.subheadline)
            }
        } else {
            Text("为命令行设备命名").font(.title2.bold())
            TextField("设备名称", text: $name).textFieldStyle(.roundedBorder).autocorrectionDisabled()
            AppGlassButton("继续", systemImage: "arrow.right", isLoading: isWorking, prominent: true) {
                Task { await prepare() }
            }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isWorking || !canConnect || creationUncertain)
            if creationUncertain {
                Text("服务器是否已创建设备尚未确认。请先关闭此页并刷新设备列表，确认结果后再创建。").font(.footnote).foregroundStyle(.secondary)
            }
        }
        if !canConnect { Text("连接恢复后可以继续，已填写的内容会保留。").font(.footnote).foregroundStyle(.secondary) }
    }

    private var canConnect: Bool { appState.nativeChatServices?.dashboardRepository.canWrite == true }
    private func prepare() async {
        guard !isWorking, !creationUncertain else { return }
        isWorking = true; error = nil
        defer { isWorking = false }
        do {
            let response = try await appState.createDevicePairing(name: name)
            credential = response
            appState.nativeChatServices?.agentSetup.watch(response.connector)
        } catch {
            creationUncertain = !V2ClientFailure.isDefiniteWriteRejection(error)
            self.error = error.localizedDescription
        }
    }
    private func claim(_ credential: V2ConnectorCreateResponse) async {
        guard !isWorking else { return }
        isWorking = true; error = nil
        defer { isWorking = false }
        do {
            let connector = try await appState.claimDevicePairing(code: code, name: credential.connector.name,
                connectorId: credential.connector.id, connectorToken: credential.connectorToken)
            appState.nativeChatServices?.agentSetup.watch(connector)
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
