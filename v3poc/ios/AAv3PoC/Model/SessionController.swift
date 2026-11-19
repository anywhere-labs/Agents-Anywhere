import Observation
import os
import SwiftUI
import UIKit

/// Owns what the phone shows: the selected session, its cache entry and the renderer. Talks to the computer only
/// through `SessionsClient`; the renderer only through `RendererBridge`.
@MainActor @Observable
final class SessionController {
    struct OpenRequest: Identifiable, Equatable {
        let id = UUID()
        let title: String
        let detail: String
    }

    var workspace: Workspace
    private(set) var selectedID: String?
    /// The latest `Session` / `Control` of the selected session. Items are not observed: they go to the renderer.
    private(set) var session: JSON?
    private(set) var control: JSON?
    private(set) var contentConnected: Bool?
    /// Live session states for the sidebar (cache entries of sessions watched in this run).
    private(set) var activities: [String: SessionActivity] = [:]
    var toast: String?
    var openRequest: OpenRequest?
    var actionError: String?
    let draft = ComposerDraft()
    private(set) var uploading = false
    private(set) var sending = false
    private var staged: [String: [StagedAttachment]] = [:]
    @ObservationIgnored private var uploadTask: Task<Void, Never>?
    @ObservationIgnored private var sendTask: Task<Void, Never>?
    @ObservationIgnored private var pendingSend: PendingSend?

    private struct PendingSend {
        let session: String
        let text: String
        let attachments: [StagedAttachment]
        let id: String
    }

    @ObservationIgnored var openDevices: (() -> Void)?
    @ObservationIgnored let bridge: RendererBridge
    @ObservationIgnored private let client: any SessionsClient
    @ObservationIgnored private let cache = SessionCache()
    @ObservationIgnored private var watchTask: Task<Void, Never>?
    @ObservationIgnored private var toastTask: Task<Void, Never>?
    @ObservationIgnored private var autoApproved: Set<String> = []

    init(workspace: Workspace, client: any SessionsClient, bridge: RendererBridge) {
        self.workspace = workspace
        self.client = client
        self.bridge = bridge
        bridge.currentSnapshot = { [weak self] in
            guard let self, let id = self.selectedID else { return nil }
            return self.cache.state(id)?.snapshot
        }
        bridge.onMessage = { [weak self] in self?.handleRenderer($0) }
        NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.memoryWarning() }
        }
        for at in DebugLaunch.rewatches {
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(at))
                guard let self, let id = self.selectedID else { return }
                LaunchClock.mark("debug: watch \(id) again")
                self.watch(id)
            }
        }
        for at in DebugLaunch.memoryWarnings {
            Task {
                try? await Task.sleep(for: .seconds(at))
                let selector = NSSelectorFromString("_performMemoryWarning")
                if UIApplication.shared.responds(to: selector) {
                    LaunchClock.mark("debug: simulate memory warning")
                    UIApplication.shared.perform(selector)
                } else {
                    LaunchClock.mark("debug: _performMemoryWarning unavailable, posting the notification")
                    NotificationCenter.default.post(name: UIApplication.didReceiveMemoryWarningNotification, object: UIApplication.shared)
                }
            }
        }
    }

    func close() {
        selectedID = nil
        watchTask?.cancel()
        toastTask?.cancel()
        uploadTask?.cancel()
        sendTask?.cancel()
    }

    // MARK: Memory

    @ObservationIgnored private var warnings: [Date] = []

    /// `warning` for a memory warning; `critical` when it is the second within 30 s (the first one did not free enough),
    /// or when the app itself is within 150 MB of its limit (`os_proc_available_memory`; 0 means unknown, as on the
    /// simulator). The WebContent process has its own limit we cannot read, so repeated warnings are the main signal.
    private func memoryWarning() {
        let now = Date()
        warnings = warnings.filter { now.timeIntervalSince($0) < 30 } + [now]
        let available = os_proc_available_memory()
        let critical = warnings.count >= 2 || (available > 0 && available < 150 * 1_048_576)
        let level = critical ? "critical" : "warning"
        LaunchClock.log("memory warning #\(warnings.count) in 30 s, available \(available / 1_048_576) MB → \(level)")
        bridge.memoryPressure(level)
        cache.trim(level, keep: selectedID)
        StressMetrics.shared.event("cacheTrimmed", ["sessions": .number(Double(cache.sessionCount)), "items": .number(Double(cache.itemCount))])
    }

    // MARK: Selection

    var workspaceClient: MeshSessionsClient? { client as? MeshSessionsClient }
    var workspaceRoot: String? {
        let root = session?["cwd"]?.string ?? selectedSummary?.cwd ?? ""
        return root.isEmpty ? workspace.projects.first?.cwd : root
    }

    var availableRuntimes: [RuntimeChoice]? { (client as? MeshSessionsClient)?.runtimes }

    func create(runtime: RuntimeChoice, cwd: String, text: String, operationID: String) async throws -> String {
        guard let mesh = client as? MeshSessionsClient else { throw NativeAccountError.invalidResponse }
        let project = workspace.projects.first { $0.cwd == cwd }
        let item = try await mesh.create(runtime: runtime, cwd: cwd, content: text, operationID: operationID, project: project)
        if !workspace.sessions.contains(where: { $0.id == item.id }) { workspace.sessions.insert(item, at: 0) }
        select(item.id)
        return item.id
    }

    var selectedSummary: Workspace.Session? { selectedID.flatMap { id in workspace.sessions.first { $0.id == id } } }

    func select(_ id: String) {
        guard id != selectedID else { return }
        selectedID = id
        contentConnected = nil
        draft.clear()
        if let index = workspace.sessions.firstIndex(where: { $0.id == id }) { workspace.sessions[index].unread = false }
        // Instant from the cache; the watch snapshot replaces it a moment later.
        if let cached = cache.state(id) {
            publish(cached)
            bridge.show(snapshot: cached.snapshot)
        } else {
            session = nil
            control = nil
        }
        watch(id)
    }

    private func watch(_ id: String) {
        watchTask?.cancel()
        watchTask = Task { [weak self] in
            var retry = 1
            while !Task.isCancelled {
                guard let self else { return }
                for await event in self.client.watch(id: id) {
                    if Task.isCancelled { return }
                    if event["type"]?.string == "snapshot" { retry = 1 }
                    self.receive(event, for: id)
                }
                try? await Task.sleep(for: .seconds(retry))
                retry = min(retry * 2, 30)
            }
        }
    }

    private func receive(_ event: JSON, for id: String) {
        if id == selectedID, client is MeshSessionsClient {
            if event["type"]?.string == "snapshot" {
                contentConnected = true
            } else if event["type"]?.string == "control", event["control"]?["state"]?.string == "disconnected" {
                contentConnected = false
            }
        }
        // What the renderer shows for this session right now: the cache before this event (every event of the selected
        // session also went to the renderer).
        let previous = event["type"]?.string == "snapshot" && id == selectedID ? cache.state(id) : nil
        guard let state = cache.apply(event, to: id) else { return }
        activities[id] = state.activity
        guard id == selectedID else { return }
        switch event["type"]?.string {
        case "snapshot":
            publish(state)
            // The cache's (bounded) state, not the raw event: the renderer gets at most `SessionCache.maxItems`
            // items; older ones come back through `loadOlder`.
            bridge.show(snapshot: state.snapshot, rendererHas: previous)
        case "session":
            session = state.session
            bridge.enqueue(event)
        case "control":
            control = state.control
            bridge.enqueue(event)
            scheduleAutoApprove()
        default:
            bridge.enqueue(event)
        }
    }

    private func publish(_ state: SessionState) {
        session = state.session
        control = state.control
        activities[state.session["id"]?.string ?? ""] = state.activity
        scheduleAutoApprove()
    }

    // MARK: What the chrome reads

    private var state: SessionState? { selectedID.flatMap { cache.state($0) } }
    var activity: SessionActivity { control.map(SessionActivity.init(control:)) ?? .idle }
    var isRunning: Bool { control?["state"]?.string == "running" }
    var pending: PendingRequest? { PendingRequest(control?["pending"]?[0]) }
    var pendingCount: Int { control?["pending"]?.array?.count ?? 0 }
    var config: [ConfigOption] { (session?["config"]?.array ?? []).compactMap(ConfigOption.init) }
    var usage: Double? {
        guard let used = control?["usage"]?["used"]?.double, let size = control?["usage"]?["size"]?.double, size > 0 else { return nil }
        return used / size
    }
    var errorMessage: String? { control?["state"]?.string == "error" ? control?["error"]?.string ?? "出错了" : nil }

    func activity(of id: String) -> SessionActivity {
        activities[id] ?? workspace.sessions.first { $0.id == id }.map { SessionActivity(summaryState: $0.state) } ?? .idle
    }

    // MARK: Actions

    var attachmentCount: Int { selectedID.flatMap { staged[$0]?.count } ?? 0 }

    func clearAttachments() {
        if let selectedID { staged.removeValue(forKey: selectedID) }
    }

    func attach(count: Int, load: @escaping (Int) async throws -> LocalChatFile) {
        guard let id = selectedID, let upload = (client as? MeshSessionsClient)?.upload,
              !uploading, !sending, count > 0 else { return }
        guard staged[id, default: []].count + count <= 5 else {
            showToast(String(localized: "connection.attachment_limit"))
            return
        }
        uploading = true
        uploadTask = Task {
            defer { uploading = false }
            do {
                for index in 0..<count {
                    try Task.checkCancellation()
                    let uploaded = try await upload(id, load(index))
                    try Task.checkCancellation()
                    staged[id, default: []].append(uploaded)
                }
            } catch is CancellationError {
                return
            } catch {
                showToast(String(localized: "connection.attachment_failed"))
            }
        }
    }

    func send() {
        guard let id = selectedID, !sending, !uploading else { return }
        let original = draft.text
        let text = original.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let files = staged[id] ?? []
        let pending: PendingSend
        if let previous = pendingSend, previous.session == id, previous.text == text, previous.attachments == files {
            pending = previous
        } else {
            pending = PendingSend(session: id, text: text, attachments: files, id: UUID().uuidString)
            pendingSend = pending
        }
        sending = true
        bridge.scrollToEnd()
        sendTask = Task {
            defer { sending = false }
            do {
                if let mesh = client as? MeshSessionsClient {
                    _ = try await mesh.send(id: id, clientMsgId: pending.id, content: text, attachments: files)
                } else {
                    _ = try await client.send(id: id, clientMsgId: pending.id, content: text)
                }
                try Task.checkCancellation()
                pendingSend = nil
                staged.removeValue(forKey: id)
                if selectedID == id, draft.text == original { draft.clear() }
            } catch is CancellationError {
                return
            } catch {
                showToast(String(localized: "connection.send_failed"))
            }
        }
    }

    func stop() {
        guard let id = selectedID else { return }
        perform { try await self.client.stop(id: id) }
    }

    func answer(_ requestID: String, option: String, haptic: Bool = true) {
        guard let id = selectedID else { return }
        if haptic { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
        perform { try await self.client.answer(id: id, requestId: requestID, optionId: option) }
    }

    func setConfig(_ configID: String, value: String) {
        guard let id = selectedID else { return }
        perform { try await self.client.setConfig(id: id, configId: configID, value: value) }
    }

    func showToast(_ text: String) {
        toast = text
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            withAnimation(.smooth) { self?.toast = nil }
        }
    }

    private func perform(_ operation: @escaping () async throws -> Void) {
        Task {
            do { try await operation() } catch { actionError = error.localizedDescription }
        }
    }

    // MARK: Renderer → native

    private func handleRenderer(_ message: JSON) {
        switch message["type"]?.string {
        case "loadOlder":
            guard let id = selectedID else { return }
            let before = message["before_seq"]?.int
            if DebugLaunch.layoutCheck { LaunchClock.log("[older] loadOlder before_seq=\(before.map(String.init) ?? "-")") }
            Task {
                guard let page = try? await client.listMessages(id: id, beforeSeq: before, limit: 50) else { return }
                cache.prepend(older: page.messages, hasMore: page.hasMore, to: id)
                if id == selectedID { bridge.older(messages: page.messages, hasMore: page.hasMore) }
            }
        case "answer":
            if let request = message["request_id"]?.string, let option = message["option_id"]?.string { answer(request, option: option) }
        case "open":
            let target = message["target"]
            switch target?["kind"]?.string {
            case "file":
                let line = target?["line"]?.int.map { ":\($0)" } ?? ""
                openRequest = .init(title: "打开文件", detail: (target?["path"]?.string ?? "") + line)
            case "url":
                openRequest = .init(title: "打开链接", detail: target?["url"]?.string ?? "")
            default: break
            }
        case "copy":
            UIPasteboard.general.string = message["text"]?.string ?? ""
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            showToast("已复制")
        case "rewind":
            showToast("演示：回退")
        case "fork":
            showToast("演示：分叉")
        case "haptic":
            switch message["style"]?.string {
            case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
            case "medium": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            default: UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
        default:
            LaunchClock.log("unhandled renderer message \(message.encodedString())")
        }
    }

    // MARK: Debug

    private func scheduleAutoApprove() {
        guard client is MockSessionsClient else { return }
        guard let seconds = DebugLaunch.autoApproveSeconds, let request = pending, !autoApproved.contains(request.requestID) else { return }
        autoApproved.insert(request.requestID)
        let option = request.options.first { !$0.isReject }?.id ?? request.options.first?.id ?? ""
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard let self, self.pending?.requestID == request.requestID else { return }
            LaunchClock.mark("auto-approve \(request.requestID) with \(option)")
            self.answer(request.requestID, option: option, haptic: false)
        }
    }
}
