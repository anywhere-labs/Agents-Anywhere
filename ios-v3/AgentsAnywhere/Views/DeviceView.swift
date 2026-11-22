import AAClientCore
import SwiftUI

struct DeviceView: View {
    let deviceID: String
    @Environment(AppModel.self) private var model
    @State private var page: Page = .conversations
    @State private var deviceModel: DeviceModel?

    enum Page: String, CaseIterable, Identifiable {
        case conversations = "对话"
        case terminals = "终端"
        case overview = "概览"
        var id: String { rawValue }
    }

    var body: some View {
        let device = model.device(deviceID)
        Group {
            if let deviceModel {
                content(deviceModel, device: device)
            } else {
                ProgressView()
            }
        }
        .navigationTitle(device?.name ?? "设备")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: 6) {
                    Text(device?.name ?? "设备").font(.headline).lineLimit(1)
                    if let device { LockView(badge: model.lockBadge(for: device)) }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { model.showingNewConversation = true } label: { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel("新对话")
                    .disabled(!(device?.isOnline ?? false))
            }
        }
        .onAppear {
            if deviceModel == nil { deviceModel = DeviceModel(app: model, deviceID: deviceID) }
            deviceModel?.start()
        }
        .onDisappear { deviceModel?.stop() }
    }

    @ViewBuilder
    private func content(_ deviceModel: DeviceModel, device: DeviceRecord?) -> some View {
        List {
            Section {
                Picker("分区", selection: $page) {
                    ForEach(Page.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            if deviceModel.needsPairing {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("这台设备开启了端到端加密", systemImage: "lock.shield")
                            .font(.headline)
                        Text("在工作设备上打开「添加客户端」，扫描它显示的二维码后才能连接。服务端无法代替你完成这一步。")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Button("扫描配对二维码") { model.pairingTarget = PairingTarget(deviceID: deviceID) }
                            .buttonStyle(.borderedProminent)
                    }
                    .padding(.vertical, 4)
                }
            } else if let error = deviceModel.error {
                Section {
                    Label(error, systemImage: deviceModel.live ? "exclamationmark.triangle" : "icloud.slash")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            switch page {
            case .conversations: conversations(deviceModel)
            case .terminals: terminals(deviceModel, online: device?.isOnline ?? false)
            case .overview: overview(deviceModel, device: device)
            }
        }
        .refreshable {
            await model.refreshSessions()
            await deviceModel.refreshStatus()
            if page == .terminals { await deviceModel.refreshTerminals() }
        }
    }

    @ViewBuilder
    private func conversations(_ deviceModel: DeviceModel) -> some View {
        let groups = deviceModel.groups
        if groups.isEmpty {
            Section {
                ContentUnavailableView {
                    Label("还没有对话", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text("点右上角新建一个对话。")
                }
            }
        }
        // Agent → project → conversation; a level with a single entry is not shown.
        ForEach(groups) { group in
            Section {
                ForEach(group.projects) { project in
                    if group.projects.count > 1 {
                        Text(project.name)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .listRowSeparator(.hidden)
                    }
                    ForEach(project.sessions) { session in
                        NavigationLink(value: Route.conversation(deviceID: deviceID, sessionID: session.id)) {
                            SessionRow(session: session)
                        }
                        .swipeActions {
                            Button(role: .destructive) {
                                Task { await deviceModel.delete(session) }
                            } label: { Label("删除", systemImage: "trash") }
                        }
                    }
                }
            } header: {
                if groups.count > 1 || group.projects.count == 1 {
                    HStack(spacing: 6) {
                        Image(systemName: AgentStyle.symbol(group.agent))
                        Text(AgentStyle.name(group.agent))
                        if group.projects.count == 1, let project = group.projects.first {
                            Text("· \(project.name)").foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func terminals(_ deviceModel: DeviceModel, online: Bool) -> some View {
        Section {
            Button {
                Task {
                    if let terminal = await deviceModel.createTerminal() {
                        model.open(.terminal(deviceID: deviceID, terminalID: terminal.id))
                    }
                }
            } label: {
                Label("新终端", systemImage: "plus.rectangle.on.rectangle")
            }
            .disabled(!online)
            ForEach(deviceModel.terminals) { terminal in
                NavigationLink(value: Route.terminal(deviceID: deviceID, terminalID: terminal.id)) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ProjectPath.name(of: terminal.cwd)).lineLimit(1)
                        Text("\(terminal.shell) · \(terminal.running ? "运行中" : "已退出") · \(RelativeTime.text(terminal.createdAt))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .swipeActions {
                    Button(role: .destructive) {
                        Task { await deviceModel.closeTerminal(terminal.id) }
                    } label: { Label("关闭", systemImage: "xmark") }
                }
            }
        }
        .task { await deviceModel.refreshTerminals() }
    }

    @ViewBuilder
    private func overview(_ deviceModel: DeviceModel, device: DeviceRecord?) -> some View {
        Section("状态") {
            LabeledContent("在线") { PresenceDot(online: device?.isOnline ?? false) }
            if let device {
                LabeledContent("平台", value: device.platform)
                LabeledContent("Connector", value: device.connectorVersion)
                LabeledContent("模式", value: device.isEncryptedHint || model.lockBadge(for: device) == .green ? "端到端加密" : "普通")
            }
            if let status = deviceModel.status {
                LabeledContent("主机名", value: status.hostname)
                LabeledContent("默认目录", value: status.cwd)
            }
        }
        Section("Agent") {
            if let status = deviceModel.status {
                if status.runtimes.isEmpty {
                    Text("这台设备上还没有可用的 Agent。").foregroundStyle(.secondary)
                }
                ForEach(status.runtimes) { runtime in
                    Label { Text(runtime.name) } icon: { AgentIcon(agent: runtime.id) }
                }
            } else {
                Text("连接后显示").foregroundStyle(.secondary)
            }
        }
        if let device, model.lockBadge(for: device) == .green, let record = model.services?.trust.record(for: deviceID) {
            Section("安全") {
                LabeledContent("设备公钥指纹") {
                    Text(KeyFingerprint.format(record.devicePub)).font(.caption.monospaced())
                }
                LabeledContent("配对时间", value: RelativeTime.text(record.pairedAt))
            }
        }
    }
}

extension LockBadge: Equatable {}
