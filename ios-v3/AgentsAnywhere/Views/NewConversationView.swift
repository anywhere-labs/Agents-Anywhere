import AAClientCore
import SwiftUI

/// New conversation: device → agent → folder (remembering the last choice), then the first message.
struct NewConversationView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage("new.device") private var lastDevice = ""
    @AppStorage("new.agent") private var lastAgent = ""
    @AppStorage("new.cwd") private var lastCwd = ""

    @State private var deviceID = ""
    @State private var agent = ""
    @State private var cwd = ""
    @State private var message = ""
    @State private var runtimes: [RuntimeInfo] = []
    @State private var defaultCwd = ""
    @State private var loadingRuntimes = false
    @State private var creating = false
    @State private var error: String?
    @State private var browsing = false

    private var onlineDevices: [DeviceRecord] { model.devices.filter(\.isOnline) }

    private var projects: [String] {
        var seen = Set<String>()
        return model.sessions(for: deviceID).map(\.cwd).filter { seen.insert($0).inserted }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("设备") {
                    if onlineDevices.isEmpty {
                        Text("没有在线的设备").foregroundStyle(.secondary)
                    }
                    Picker("设备", selection: $deviceID) {
                        ForEach(onlineDevices) { device in
                            HStack {
                                Text(device.name)
                                LockView(badge: model.lockBadge(for: device))
                            }
                            .tag(device.id)
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }

                Section("Agent") {
                    if loadingRuntimes {
                        ProgressView()
                    } else if runtimes.isEmpty, !deviceID.isEmpty {
                        Text("这台设备上没有可用的 Agent").foregroundStyle(.secondary)
                    }
                    Picker("Agent", selection: $agent) {
                        ForEach(runtimes) { runtime in
                            Label { Text(runtime.name) } icon: { AgentIcon(agent: runtime.id) }.tag(runtime.id)
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }

                Section {
                    Picker("目录", selection: $cwd) {
                        Text(defaultCwd.isEmpty ? "默认目录" : "默认目录（\(ProjectPath.name(of: defaultCwd))）").tag("")
                        ForEach(projects, id: \.self) { path in
                            Text(ProjectPath.name(of: path)).tag(path)
                        }
                        if !cwd.isEmpty, !projects.contains(cwd) {
                            Text(ProjectPath.name(of: cwd)).tag(cwd)
                        }
                    }
                    Button("浏览设备上的目录…") { browsing = true }
                        .disabled(deviceID.isEmpty)
                } header: {
                    Text("项目目录")
                } footer: {
                    if !cwd.isEmpty { Text(cwd).font(.caption.monospaced()) }
                }

                Section("第一条消息") {
                    TextField("要 Agent 做什么？（可以留空）", text: $message, axis: .vertical)
                        .lineLimit(3...8)
                }

                if let error {
                    Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red) }
                }
            }
            .navigationTitle("新对话")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if creating {
                        ProgressView()
                    } else {
                        Button("开始") { create() }
                            .disabled(deviceID.isEmpty || agent.isEmpty)
                    }
                }
            }
            .sheet(isPresented: $browsing) {
                DirectoryBrowser(deviceID: deviceID, start: cwd.isEmpty ? nil : cwd) { picked in cwd = picked }
            }
            .task {
                let preferred = onlineDevices.first { $0.id == lastDevice } ?? onlineDevices.first
                deviceID = preferred?.id ?? ""
            }
            .task(id: deviceID) { await loadRuntimes() }
        }
    }

    private func loadRuntimes() async {
        guard let services = model.services, !deviceID.isEmpty else { return }
        loadingRuntimes = true
        defer { loadingRuntimes = false }
        error = nil
        do {
            let status = try await services.tunnels.status(deviceID)
            runtimes = status.runtimes
            defaultCwd = status.cwd
            agent = runtimes.first { $0.id == lastAgent }?.id ?? runtimes.first?.id ?? ""
            cwd = deviceID == lastDevice ? lastCwd : ""
        } catch {
            runtimes = []
            self.error = AppModel.describe(error)
        }
    }

    private func create() {
        guard let services = model.services else { return }
        creating = true
        error = nil
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            defer { creating = false }
            do {
                let session = try await services.tunnels.createSession(deviceID, agent: agent, cwd: cwd.isEmpty ? nil : cwd)
                lastDevice = deviceID
                lastAgent = agent
                lastCwd = cwd
                if !text.isEmpty {
                    _ = try await services.tunnels.send(deviceID, sessionID: session.id, clientMsgID: UUID().uuidString.lowercased(), content: text)
                }
                dismiss()
                model.selection = .conversation(deviceID: deviceID, sessionID: session.id)
                Task { await model.refreshSessions() }
            } catch {
                self.error = AppModel.describe(error)
            }
        }
    }
}

/// Browse folders on a device (`aa.v3.Device/list_dirs`) and pick one.
struct DirectoryBrowser: View {
    let deviceID: String
    let start: String?
    let onPick: (String) -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var listing: ListDirsResult?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if let error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.secondary) }
                if let listing {
                    if let parent = listing.parent {
                        Button { Task { await load(parent) } } label: { Label("上一级", systemImage: "arrow.turn.left.up") }
                    }
                    ForEach(listing.entries.filter(\.isDir)) { entry in
                        Button { Task { await load(entry.path) } } label: {
                            Label(entry.name, systemImage: "folder")
                        }
                        .foregroundStyle(.primary)
                    }
                } else if error == nil {
                    ProgressView()
                }
            }
            .navigationTitle(listing.map { ProjectPath.name(of: $0.path) } ?? "目录")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("选这里") {
                        if let listing { onPick(listing.path) }
                        dismiss()
                    }
                    .disabled(listing == nil)
                }
            }
            .task { await load(start) }
        }
    }

    private func load(_ path: String?) async {
        guard let services = model.services else { return }
        do {
            listing = try await services.tunnels.listDirs(deviceID, path: path)
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }
}
