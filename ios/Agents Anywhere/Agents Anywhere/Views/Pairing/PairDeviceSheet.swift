import SwiftUI
import UIKit

struct PairDeviceSheet: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var path: [Step] = []
    @State private var name = String(localized: "New device")
    @State private var code = ""
    @State private var credential: V2ConnectorCreateResponse?
    @State private var isWorking = false
    @State private var creationUncertain = false
    @State private var error: String?
    @State private var copied = false
    private enum Step: Hashable { case connectionMethod, desktop, cliConfirm, name, cliMethod, pairCode, token }

    var body: some View {
        NavigationStack(path: $path) {
            page(.connectionMethod)
                .navigationDestination(for: Step.self) { page($0) }
        }
        .appSheetPresentation(.compact)
        .disabled(isWorking)
        .interactiveDismissDisabled(isWorking)
        .onChange(of: path) { _, _ in error = nil; copied = false }
    }

    private func page(_ step: Step) -> some View {
        Group {
            if step == .name { nameForm }
            else if step == .pairCode { pairCodeForm }
            else { instructionsPage(step) }
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

    private func instructionsPage(_ step: Step) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if step == .desktop { desktopInstructions }
                else if step == .cliConfirm { cliConfirmation }
                else if step != .connectionMethod { cliInstructions(step) }
                else {
                    Text(String(localized: "选择设备的连接方式")).font(.title2.bold())
                    Text(String(localized: "dashboard.pairDevice.connectionDescription")).foregroundStyle(.secondary)
                    AppGlassButton(String(localized: "桌面应用"), systemImage: "desktopcomputer", style: .prominent) {
                        path.append(.desktop)
                    }
                    Text(String(localized: "在电脑上安装桌面应用，并登录同一账号。设备会自动显示在侧栏。")).foregroundStyle(.secondary)
                    AppGlassButton(String(localized: "命令行"), systemImage: "terminal") {
                        path.append(.cliConfirm)
                    }
                    Text(String(localized: "适合通过 CLI 连接远程主机或无界面的设备。")).foregroundStyle(.secondary)
                }
                if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            }.padding(22).frame(maxWidth: 560)
        }
    }

    private var nameForm: some View {
        Form {
            Section {
                TextField(String(localized: "dashboard.pairDevice.namePlaceholder"), text: $name)
                    .textFieldStyle(.plain).autocorrectionDisabled()
                    .submitLabel(.continue).onSubmit(continuePairing)
            } header: {
                Text(String(localized: "设备名称")).textCase(nil)
            } footer: {
                Text(String(localized: "dashboard.pairDevice.nameDescription"))
            }
            Section {
                AppGlassButton(String(localized: "继续"), systemImage: "arrow.right", style: .prominent,
                    isLoading: isWorking, action: continuePairing)
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isWorking || !canConnect || creationUncertain)
            }.listRowBackground(Color.clear).listRowInsets(EdgeInsets())
            if creationUncertain {
                Text(String(localized: "服务器是否已创建设备尚未确认。请先关闭此页并刷新设备列表，确认结果后再创建。"))
                    .font(.footnote).foregroundStyle(.secondary)
            }
            pairingMessages
        }
        .scrollContentBackground(.hidden).scrollDismissesKeyboard(.interactively)
        .frame(maxWidth: 560).frame(maxWidth: .infinity)
    }

    @ViewBuilder private var pairCodeForm: some View {
        if let credential, let server = appState.serverURL {
            Form {
                if !isReady(credential) {
                    Section {
                        Text(String(localized: "先在目标设备运行以下命令，再填写 CLI 显示的配对码。"))
                            .foregroundStyle(.secondary)
                        commandBlock(V2PairingCommand.pair(server: server))
                    } header: {
                        Text(credential.connector.name).textCase(nil)
                    }.listRowBackground(Color.clear)
                    Section {
                        OneTimeCodeField(code: $code, title: String(localized: "dashboard.pairDevice.codeLabel"))
                    }
                    Section {
                        AppGlassButton(String(localized: "连接设备"), systemImage: "link", style: .prominent, isLoading: isWorking) {
                            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                            Task { await claim(credential) }
                        }.disabled(code.count != 6 || isWorking || !canConnect)
                    }.listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                }
                pairingStatus(credential)
                pairingMessages
            }
            .scrollContentBackground(.hidden).scrollDismissesKeyboard(.interactively)
            .frame(maxWidth: 560).frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder private var pairingMessages: some View {
        if !canConnect {
            Text(String(localized: "连接恢复后可以继续，已填写的内容会保留。"))
                .font(.footnote).foregroundStyle(.secondary)
        }
        if let error { Text(error).font(.footnote).foregroundStyle(.red) }
    }

    private func continuePairing() {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        Task { await Task.yield(); await prepare() }
    }

    private func title(for step: Step) -> String {
        switch step {
        case .connectionMethod: String(localized: "添加设备")
        case .desktop: String(localized: "桌面应用")
        case .cliConfirm: String(localized: "命令行")
        case .name: String(localized: "dashboard.pairDevice.nameTitle")
        case .cliMethod: String(localized: "选择配对方式")
        case .pairCode: String(localized: "dashboard.pairDevice.codeStepTitle")
        case .token: String(localized: "dashboard.pairDevice.commandStepTitle")
        }
    }

    private var desktopInstructions: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label(String(localized: "Agents Anywhere Desktop"), appSymbol: "desktopcomputer").font(.title2.bold())
            Text(String(localized: "在电脑上安装桌面应用，使用以下服务器地址登录当前账号。连接后，可以在设备管理中添加 Agent。"))
            Text(appState.serverURL?.absoluteString ?? "").font(.callout.monospaced()).textSelection(.enabled)
            AppGlassButton(String(localized: "下载桌面应用"), style: .prominent) {
                openURL(URL(string: "https://agents-anywhere.com/")!)
            }
        }
    }

    private var cliConfirmation: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(String(localized: "确定要使用命令行吗？")).font(.title2.bold())
            Text(String(localized: "此方式需要会使用终端以及 uv / uvx 命令行工具。"))
            Text(String(localized: "如果使用 Windows 或 macOS，桌面程序的连接和日常使用更方便。"))
                .foregroundStyle(.secondary)
            AppGlassButton(String(localized: "继续使用命令行"), style: .prominent) {
                path.append(.name)
            }
            AppGlassButton(String(localized: "使用桌面程序")) {
                path.append(.desktop)
            }
        }
    }

    @ViewBuilder private func cliInstructions(_ step: Step) -> some View {
        if let credential, let server = appState.serverURL {
            Text(credential.connector.name).font(.title2.bold())
            if !isReady(credential) {
                if step == .cliMethod {
                    Text(String(localized: "Choose how to connect \(credential.connector.name) to your account.")).foregroundStyle(.secondary)
                    AppGlassButton(String(localized: "使用配对码"), systemImage: "number", style: .prominent) {
                        path.append(.pairCode)
                    }
                    Text(String(localized: "在设备上运行命令，将生成的六位配对码填回这里。"))
                        .font(.footnote).foregroundStyle(.secondary)
                    AppGlassButton(String(localized: "使用 Token"), systemImage: "key") {
                        path.append(.token)
                    }
                    Text(String(localized: "dashboard.pairDevice.tokenDescription"))
                        .font(.footnote).foregroundStyle(.secondary)
                } else {
                    Text(String(localized: "Run this command in the terminal on \(credential.connector.name) to connect it to your account automatically."))
                        .foregroundStyle(.secondary)
                    commandBlock(V2PairingCommand.start(server: server, credential: credential))
                }
            }
            pairingStatus(credential)
        }
        if !canConnect { Text(String(localized: "连接恢复后可以继续，已填写的内容会保留。"))
            .font(.footnote).foregroundStyle(.secondary) }
    }

    private func isReady(_ credential: V2ConnectorCreateResponse) -> Bool {
        appState.nativeChatServices?.agentSetup.requests.first(where: { $0.id == credential.connector.id })?.ready == true
    }

    @ViewBuilder private func pairingStatus(_ credential: V2ConnectorCreateResponse) -> some View {
        if let setup = appState.nativeChatServices?.agentSetup,
           let request = setup.requests.first(where: { $0.id == credential.connector.id }) {
            if request.ready {
                Label(String(localized: "设备已连接"), appSymbol: "checkmark.circle").font(.headline)
                Text(String(localized: "\(credential.connector.name) is online. You can now choose which agents to configure and start on this device, or finish without adding any."))
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
