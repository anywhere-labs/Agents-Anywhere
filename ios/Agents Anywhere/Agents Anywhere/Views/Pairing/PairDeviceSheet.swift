import SwiftUI
import UIKit

struct PairDeviceSheet: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var path: [Step] = []
    @State private var name = String(localized: "New device")
    @State private var code = ""
    @State private var credential: V2ConnectorCreateResponse?
    @State private var isWorking = false
    @State private var creationUncertain = false
    @State private var error: String?
    @State private var copied = false
    private enum Step: Hashable { case connectionMethod, desktop, cliConfirm, name, cliMethod, pairCode, token }
    private var step: Step { path.last ?? .connectionMethod }

    var body: some View {
        NavigationStack(path: $path) {
            page(.connectionMethod)
                .navigationDestination(for: Step.self) { page($0) }
        }
        .appSheetPresentation(step == .pairCode || step == .token ? .expanded : .compact)
        .disabled(isWorking)
        .interactiveDismissDisabled(isWorking)
        .onChange(of: path) { _, _ in error = nil; copied = false }
    }

    private func page(_ step: Step) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if step == .desktop { desktopInstructions }
                else if step == .cliConfirm { cliConfirmation }
                else if step != .connectionMethod { cliInstructions(step) }
                else {
                    Text(String(localized: "选择设备的连接方式")).font(.title2.bold())
                    NavigationLink(value: Step.desktop) {
                        Label(String(localized: "桌面应用"), appSymbol: "desktopcomputer").frame(maxWidth: .infinity)
                    }.buttonStyle(.glassProminent).controlSize(.large)
                    Text(String(localized: "在电脑上安装桌面应用，并登录同一账号。设备会自动显示在侧栏。")).foregroundStyle(.secondary)
                    NavigationLink(value: Step.cliConfirm) {
                        Label(String(localized: "命令行"), appSymbol: "terminal").frame(maxWidth: .infinity)
                    }.buttonStyle(.glass).controlSize(.large)
                    Text(String(localized: "适合通过 CLI 连接远程主机或无界面的设备。")).foregroundStyle(.secondary)
                }
                if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            }.padding(22).frame(maxWidth: 560)
        }
        .frame(maxWidth: .infinity)
        .navigationTitle(title(for: step))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { SheetCloseToolbar(disabled: isWorking) { dismiss() } }
        .onAppear {
            if step == .token, let credential {
                appState.nativeChatServices?.agentSetup.watch(credential.connector)
            }
        }
    }

    private func title(for step: Step) -> String {
        switch step {
        case .connectionMethod: String(localized: "添加设备")
        case .desktop: String(localized: "桌面应用")
        case .cliConfirm: String(localized: "命令行")
        case .name: String(localized: "设备名称")
        case .cliMethod: String(localized: "选择配对方式")
        case .pairCode: String(localized: "使用配对码")
        case .token: String(localized: "使用 Token")
        }
    }

    private var desktopInstructions: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label(String(localized: "Agents Anywhere Desktop"), appSymbol: "desktopcomputer").font(.title2.bold())
            Text(String(localized: "在电脑上安装桌面应用，使用以下服务器地址登录当前账号。连接后，可以在设备管理中添加 Agent。"))
            Text(appState.serverURL?.absoluteString ?? "").font(.callout.monospaced()).textSelection(.enabled)
            Link(String(localized: "下载桌面应用"), destination: URL(string: "https://github.com/anywhere-labs/Agents-Anywhere/releases/latest")!)
                .buttonStyle(.glassProminent)
        }
    }

    private var cliConfirmation: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(String(localized: "确定要使用命令行吗？")).font(.title2.bold())
            Text(String(localized: "此方式需要会使用终端以及 uv / uvx 命令行工具。"))
            Text(String(localized: "如果使用 Windows 或 macOS，桌面程序的连接和日常使用更方便。"))
                .foregroundStyle(.secondary)
            NavigationLink(value: Step.name) {
                Text(String(localized: "继续使用命令行")).frame(maxWidth: .infinity)
            }.buttonStyle(.glassProminent).controlSize(.large)
            NavigationLink(value: Step.desktop) {
                Text(String(localized: "使用桌面程序")).frame(maxWidth: .infinity)
            }.buttonStyle(.glass).controlSize(.large)
        }
    }

    @ViewBuilder private func cliInstructions(_ step: Step) -> some View {
        if step == .name {
            Text(String(localized: "为命令行设备命名")).font(.title2.bold())
            TextField(String(localized: "设备名称"), text: $name).textFieldStyle(.roundedBorder).autocorrectionDisabled()
            AppGlassButton(String(localized: "继续"), systemImage: "arrow.right", style: .prominent, isLoading: isWorking) {
                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                Task { await Task.yield(); await prepare() }
            }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isWorking || !canConnect || creationUncertain)
            if creationUncertain {
                Text(String(localized: "服务器是否已创建设备尚未确认。请先关闭此页并刷新设备列表，确认结果后再创建。"))
                    .font(.footnote).foregroundStyle(.secondary)
            }
        } else if let credential, let server = appState.serverURL {
            Text(credential.connector.name).font(.title2.bold())
            if appState.nativeChatServices?.agentSetup.requests.first(where: { $0.id == credential.connector.id })?.ready != true {
                if step == .cliMethod {
                    Text(String(localized: "选择配对方式")).foregroundStyle(.secondary)
                    NavigationLink(value: Step.pairCode) {
                        Label(String(localized: "使用配对码"), appSymbol: "number").frame(maxWidth: .infinity)
                    }.buttonStyle(.glassProminent).controlSize(.large)
                    Text(String(localized: "在设备上运行命令，将生成的六位配对码填回这里。"))
                        .font(.footnote).foregroundStyle(.secondary)
                    NavigationLink(value: Step.token) {
                        Label(String(localized: "使用 Token"), appSymbol: "key").frame(maxWidth: .infinity)
                    }.buttonStyle(.glass).controlSize(.large)
                } else if step == .pairCode {
                    Text(String(localized: "先在目标设备运行以下命令，再填写 CLI 显示的配对码。"))
                        .foregroundStyle(.secondary)
                    commandBlock(V2PairingCommand.pair(server: server))
                    TextField("000000", text: $code).keyboardType(.numberPad).textContentType(.oneTimeCode)
                        .font(.title2.monospaced()).textFieldStyle(.roundedBorder)
                        .onChange(of: code) { _, value in code = String(value.filter { $0.isASCII && $0.isNumber }.prefix(6)) }
                    AppGlassButton(String(localized: "连接设备"), systemImage: "link", style: .prominent, isLoading: isWorking) {
                        Task { await claim(credential) }
                    }.disabled(code.count != 6 || isWorking || !canConnect)
                } else {
                    Text(String(localized: "在目标设备运行以下命令，然后保持 CLI 运行。即使关闭此页面，我们也会继续等待设备连接。"))
                        .foregroundStyle(.secondary)
                    commandBlock(V2PairingCommand.start(server: server, credential: credential))
                    Text(String(localized: "命令包含设备凭据，请仅在你信任的设备上使用。"))
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            if let setup = appState.nativeChatServices?.agentSetup,
               let request = setup.requests.first(where: { $0.id == credential.connector.id }) {
                if request.ready {
                    Label(String(localized: "设备已连接"), appSymbol: "checkmark.circle").font(.headline)
                    Text(String(localized: "可以现在配置 Agent，也可以稍后在设备页面添加。"))
                        .font(.footnote).foregroundStyle(.secondary)
                    AppGlassButton(String(localized: "配置 Agent"), style: .prominent) { setup.configure(request.id); dismiss() }
                    AppGlassButton(String(localized: "稍后配置")) { setup.finish(request.id); dismiss() }
                } else {
                    HStack {
                        if request.error == nil { ProgressView() }
                        Text(request.error ?? String(localized: "等待设备连接…"))
                    }.font(.subheadline)
                }
            }
        }
        if !canConnect { Text(String(localized: "连接恢复后可以继续，已填写的内容会保留。"))
            .font(.footnote).foregroundStyle(.secondary) }
    }

    private func commandBlock(_ command: String) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(command).font(.footnote.monospaced()).textSelection(.enabled)
                .padding(16).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
            AppGlassButton(copied ? String(localized: "已复制") : String(localized: "复制命令"), systemImage: copied ? "checkmark" : "doc.on.doc") {
                UIPasteboard.general.string = command; copied = true
            }
        }.onChange(of: command) { _, _ in copied = false }
    }
    private var canConnect: Bool { appState.nativeChatServices?.dashboardRepository.canWrite == true }
    private func prepare() async {
        guard !isWorking, !creationUncertain, canConnect else { return }
        let submittedPath = path
        isWorking = true; error = nil
        defer { isWorking = false }
        do {
            if let previous = credential, let services = appState.nativeChatServices {
                if name.trimmingCharacters(in: .whitespacesAndNewlines) != previous.connector.name {
                    let connector = try await services.deviceManagement.renameConnector(connectorId: previous.connector.id, name: name)
                    guard appState.nativeChatServices === services else { throw CancellationError() }
                    appState.updateConnector(connector)
                    credential = .init(connector: connector, connectorToken: previous.connectorToken, tokenPrefix: previous.tokenPrefix)
                }
            } else { credential = try await appState.createDevicePairing(name: name) }
            if path == submittedPath { path.append(.cliMethod) }
        } catch {
            creationUncertain = credential == nil && !V2ClientFailure.isDefiniteWriteRejection(error)
            self.error = error.localizedDescription
        }
    }
    private func claim(_ credential: V2ConnectorCreateResponse) async {
        guard !isWorking, canConnect else { return }
        isWorking = true; error = nil
        defer { isWorking = false }
        do {
            let connector = try await appState.claimDevicePairing(code: code, name: credential.connector.name,
                connectorId: credential.connector.id, connectorToken: credential.connectorToken)
            appState.nativeChatServices?.agentSetup.watch(connector)
            code = ""
        } catch { self.error = error.localizedDescription }
    }
}
