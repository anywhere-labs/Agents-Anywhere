import AAClientCore
import SwiftUI

/// Phone: one stack (devices / conversations → conversation). iPad / wide: sidebar + detail.
/// The sidebar only comes in from the screen edge (system split view behaviour); nothing here adds gestures.
struct MainView: View {
    @Environment(AppModel.self) private var model
    @State private var columns: NavigationSplitViewVisibility = .automatic

    var body: some View {
        @Bindable var model = model
        NavigationSplitView(columnVisibility: $columns) {
            HomeView()
        } detail: {
            NavigationStack(path: $model.path) {
                detailRoot
                    .navigationDestination(for: Route.self) { route in
                        destination(route)
                    }
            }
        }
        .onChange(of: model.selection) { model.path = NavigationPath() }
        .sheet(isPresented: $model.showingNewConversation) {
            NewConversationView()
        }
        .sheet(isPresented: $model.showingSettings) {
            SettingsView()
        }
        .sheet(item: $model.pairingTarget) { target in
            PairingView(expectedDeviceID: target.deviceID)
        }
    }

    @ViewBuilder
    private var detailRoot: some View {
        switch model.selection {
        case .device(let id):
            DeviceView(deviceID: id)
                .id(id)
        case .conversation(let deviceID, let sessionID):
            ConversationView(deviceID: deviceID, sessionID: sessionID)
                .id(sessionID)
        case nil:
            ContentUnavailableView("选择设备或对话", systemImage: "sidebar.left", description: Text("从左侧选择一台设备或一个最近的对话。"))
        }
    }

    @ViewBuilder
    private func destination(_ route: Route) -> some View {
        switch route {
        case .device(let id):
            DeviceView(deviceID: id)
        case .conversation(let deviceID, let sessionID):
            ConversationView(deviceID: deviceID, sessionID: sessionID)
        case .terminal(let deviceID, let terminalID):
            TerminalView(deviceID: deviceID, terminalID: terminalID)
        }
    }
}

struct HomeView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        List(selection: $model.selection) {
            if let error = model.devicesError {
                Section {
                    Label(error, systemImage: "wifi.exclamationmark")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            let recent = Array(model.recentSessions.prefix(8))
            if !recent.isEmpty {
                Section("最近对话") {
                    ForEach(recent) { session in
                        SessionRow(session: session, deviceName: model.device(session.deviceID)?.name)
                            .tag(SidebarItem.conversation(deviceID: session.deviceID, sessionID: session.id))
                    }
                }
            }

            Section("设备") {
                if model.devices.isEmpty {
                    if model.devicesLoaded || model.devicesError != nil {
                        ContentUnavailableView {
                            Label("还没有设备", systemImage: "laptopcomputer.and.iphone")
                        } description: {
                            Text("在工作电脑上安装 Agents Anywhere Desktop 或 Connector 并登录同一个账号，设备就会出现在这里。")
                        }
                    } else {
                        HStack { Spacer(); ProgressView(); Spacer() }
                    }
                }
                ForEach(model.devices) { device in
                    DeviceRow(device: device, badge: model.lockBadge(for: device))
                        .tag(SidebarItem.device(device.id))
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Agents Anywhere")
        .refreshable { await model.refreshSessions() }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { model.showingSettings = true } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel("设置")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { model.showingNewConversation = true } label: { Label("新对话", systemImage: "square.and.pencil") }
                    Button { model.pairingTarget = PairingTarget(deviceID: nil) } label: { Label("配对加密设备", systemImage: "qrcode.viewfinder") }
                } label: {
                    Image(systemName: "square.and.pencil")
                } primaryAction: {
                    model.showingNewConversation = true
                }
                .accessibilityLabel("新对话")
            }
        }
    }
}

struct DeviceRow: View {
    let device: DeviceRecord
    let badge: LockBadge

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: DeviceStyle.symbol(device.platform))
                .foregroundStyle(.secondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(device.name).lineLimit(1)
                    LockView(badge: badge)
                }
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            PresenceDot(online: device.isOnline)
        }
        .accessibilityElement(children: .combine)
    }

    private var subtitle: String {
        if !device.isOnline {
            let seen = RelativeTime.text(device.lastSeenAt)
            return seen.isEmpty ? "离线" : "离线 · \(seen)"
        }
        if let summary = device.summary {
            var parts: [String] = []
            if let runtimes = summary.runtimes, !runtimes.isEmpty { parts.append(runtimes.map(AgentStyle.name).joined(separator: "、")) }
            if let active = summary.activeSessions, active > 0 { parts.append("\(active) 个运行中") }
            if let pending = summary.pendingApprovals, pending > 0 { parts.append("\(pending) 个待审批") }
            if !parts.isEmpty { return parts.joined(separator: " · ") }
        }
        return device.isEncryptedHint ? "在线 · 端到端加密" : "在线"
    }
}
