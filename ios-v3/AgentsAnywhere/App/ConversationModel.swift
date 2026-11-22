import AAClientCore
import Foundation
import Observation
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// A picked attachment, uploaded to the device before the message is sent.
struct DraftAttachment: Identifiable, Equatable {
    enum State: Equatable {
        case uploading
        case ready(AttachmentPart)
        case failed(String)
    }

    let id = UUID()
    var name: String
    var mime: String
    var size: Int
    var preview: UIImage?
    var state: State

    static func == (a: DraftAttachment, b: DraftAttachment) -> Bool { a.id == b.id && a.state == b.state }
}

/// One conversation screen: the `watch` stream (forwarded to the WebView unchanged), native controls state
/// (approvals, queue, config, running/stop), sending, attachments, and the read-only offline cache.
@MainActor
@Observable
final class ConversationModel {
    let deviceID: String
    let sessionID: String
    let bridge = RenderBridge()

    private(set) var state = ConversationState()
    private(set) var connection: ConnectionState = .connecting
    private(set) var encrypted = false
    private(set) var cachedAt: Date?
    var draft = ""
    var attachments: [DraftAttachment] = []
    var errorMessage: String?
    private(set) var sending = false
    private(set) var atBottom = true
    private(set) var answering: Set<String> = []

    enum ConnectionState: Equatable {
        case connecting
        case live
        /// Showing the cache, read-only.
        case offline(String)
    }

    private weak var app: AppModel?
    private var watchTask: Task<Void, Never>?
    private var saveTask: Task<Void, Never>?
    private var theme: RenderTheme?

    init(app: AppModel, deviceID: String, sessionID: String) {
        self.app = app
        self.deviceID = deviceID
        self.sessionID = sessionID
        bridge.onMessage = { [weak self] message in self?.handle(message) }
    }

    var services: AppServices? { app?.services }
    var session: Session? { state.session }
    var control: Control { state.control }
    var readonly: Bool { if case .live = connection { false } else { true } }
    var title: String {
        let title = session?.title ?? ""
        return title.isEmpty ? "新对话" : title
    }

    var canSend: Bool {
        !readonly && !sending && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || readyAttachments.count > 0)
            && !attachments.contains { $0.state == .uploading }
    }

    private var readyAttachments: [AttachmentPart] {
        attachments.compactMap { if case .ready(let part) = $0.state { part } else { nil } }
    }

    // MARK: Lifecycle

    func start() {
        guard watchTask == nil else { return }
        watchTask = Task { [weak self] in await self?.watchLoop() }
    }

    func stop() {
        watchTask?.cancel()
        watchTask = nil
        persist(now: true)
    }

    private func watchLoop() async {
        var delay: Double = 1
        while !Task.isCancelled {
            guard let services else { return }
            if let device = app?.device(deviceID), !device.isOnline {
                await showCache(reason: "设备离线")
                try? await Task.sleep(for: .seconds(5))
                continue
            }
            connection = .connecting
            do {
                for try await update in services.tunnels.watch(deviceID, sessionID: sessionID) {
                    if connection != .live {
                        connection = .live
                        encrypted = await services.tunnels.tunnelInfo(deviceID)?.encrypted ?? false
                        sendView()
                    }
                    delay = 1
                    state.apply(update)
                    if bridge.isReady { bridge.send(BridgeOut.conversationEvent(sessionID: sessionID, event: update.raw)) }
                    persist(now: false)
                }
            } catch {
                if Task.isCancelled { return }
                if let pairing = error as? PairingError {
                    await showCache(reason: pairing.message)
                    return
                }
                await showCache(reason: AppModel.describe(error))
            }
            try? await Task.sleep(for: .seconds(delay))
            delay = min(delay * 2, 20)
        }
    }

    private func showCache(reason: String) async {
        let alreadyOffline = if case .offline = connection { true } else { false }
        connection = .offline(reason)
        guard !alreadyOffline || cachedAt == nil, let services else { return }
        if state.sessionRaw == nil, let cached = await services.cache.conversation(sessionID: sessionID) {
            state.replaceMessages(cached.messages)
            state.sessionRaw = cached.session
            state.session = cached.typedSession
            state.controlRaw = cached.control
            state.control = (try? cached.control.decode(as: Control.self)) ?? .idle
            cachedAt = cached.savedAt
        }
        sendView()
    }

    private func persist(now: Bool) {
        guard let cache = services?.cache, let snapshot = CachedConversation(state) else { return }
        saveTask?.cancel()
        let sessionID = sessionID
        saveTask = Task {
            if !now { try? await Task.sleep(for: .seconds(1)) }
            guard !Task.isCancelled else { return }
            await cache.saveConversation(snapshot, sessionID: sessionID)
        }
    }

    // MARK: Bridge

    func updateTheme(_ theme: RenderTheme) {
        guard theme != self.theme else { return }
        self.theme = theme
        bridge.send(theme.message)
    }

    /// Everything the page needs after `ready` (first load or a reload).
    private func sendView() {
        guard bridge.isReady else { return }
        var messages: [JSONValue] = []
        if let theme { messages.append(theme.message) }
        messages.append(BridgeOut.locale(Locale.preferredLanguages.first ?? "zh-CN"))
        messages.append(BridgeOut.viewConversation(
            deviceID: deviceID, sessionID: sessionID, agent: session?.agent ?? "", readonly: readonly, encrypted: encrypted))
        if case .live = connection, let sessionRaw = state.sessionRaw {
            let snapshot: JSONValue = [
                "type": "snapshot", "session": sessionRaw, "messages": .array(state.messages), "has_more": .bool(state.hasMore),
                "control": state.controlRaw ?? .object([:]),
            ]
            messages.append(BridgeOut.conversationEvent(sessionID: sessionID, event: snapshot))
        } else if state.sessionRaw != nil {
            messages.append(BridgeOut.conversationCached(sessionID: sessionID, messages: state.messages, control: state.controlRaw ?? .object([:])))
        }
        bridge.send(messages)
    }

    private func handle(_ message: BridgeIn) {
        switch message {
        case .ready:
            sendView()
        case .loadOlder(let id, let beforeSeq) where id == sessionID:
            loadOlder(beforeSeq: beforeSeq)
        case .answer(let id, let requestID, let optionID) where id == sessionID:
            answer(requestID: requestID, optionID: optionID)
        case .openLink(let url):
            UIApplication.shared.open(url)
        case .copy(let text):
            UIPasteboard.general.string = text
        case .haptic(let kind):
            Haptics.play(kind)
        case .scrollState(let bottom, _):
            if bottom != atBottom { atBottom = bottom }
        case .fileRead(let requestID, let path, let maxBytes):
            readFile(requestID: requestID, path: path, maxBytes: maxBytes)
        case .openFile(let path, _):
            errorMessage = "文件预览还没有做：\(path)"
        default:
            break
        }
    }

    func scrollToBottom() {
        bridge.send(BridgeOut.scroll(toBottom: true))
    }

    private func loadOlder(beforeSeq: Int) {
        guard let services, !readonly else { return }
        Task {
            do {
                let page = try await services.tunnels.listMessages(deviceID, sessionID: sessionID, beforeSeq: beforeSeq)
                state.prepend(page.messages, hasMore: page.hasMore)
                bridge.send(BridgeOut.conversationOlder(sessionID: sessionID, messages: page.messages, hasMore: page.hasMore))
            } catch {
                bridge.send(BridgeOut.conversationOlder(sessionID: sessionID, messages: [], hasMore: true))
            }
        }
    }

    private func readFile(requestID: String, path: String, maxBytes: Int?) {
        guard let services else { return }
        Task {
            do {
                let limit = min(maxBytes ?? DeviceTunnelPool.maxRPCAttachmentBytes, DeviceTunnelPool.maxRPCAttachmentBytes)
                let result = try await services.tunnels.readFile(deviceID, path: path, maxBytes: limit)
                let mime = UTType(filenameExtension: (path as NSString).pathExtension)?.preferredMIMEType
                bridge.send(BridgeOut.fileData(requestID: requestID, data: result.data, mime: mime, error: nil))
            } catch {
                bridge.send(BridgeOut.fileData(requestID: requestID, data: nil, mime: nil, error: AppModel.describe(error)))
            }
        }
    }

    // MARK: Actions

    /// Send the draft. While a turn runs: `.queue` waits for it, `.steer` interrupts and goes next.
    func send(_ delivery: Delivery = .auto) {
        guard canSend, let services else { return }
        let content = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = readyAttachments
        let clientMsgID = UUID().uuidString.lowercased()
        let previousDraft = draft
        let previousAttachments = attachments
        draft = ""
        attachments = []
        sending = true
        Task {
            defer { sending = false }
            do {
                _ = try await services.tunnels.send(
                    deviceID, sessionID: sessionID, clientMsgID: clientMsgID, content: content, delivery: delivery, attachments: parts)
                Haptics.play("light")
                scrollToBottom()
            } catch {
                draft = previousDraft
                attachments = previousAttachments
                errorMessage = "发送失败：\(AppModel.describe(error))"
            }
        }
    }

    func stopTurn() {
        guard let services else { return }
        Task {
            do { try await services.tunnels.stop(deviceID, sessionID: sessionID) } catch { errorMessage = AppModel.describe(error) }
        }
    }

    func answer(requestID: String, optionID: String) {
        guard let services, !answering.contains(requestID) else { return }
        answering.insert(requestID)
        Task {
            defer { answering.remove(requestID) }
            do {
                try await services.tunnels.answer(deviceID, sessionID: sessionID, requestID: requestID, optionID: optionID)
                Haptics.play("success")
            } catch {
                errorMessage = "审批没有送达：\(AppModel.describe(error))"
            }
        }
    }

    func setConfig(_ option: ConfigOption, value: String) {
        guard let services, value != option.current else { return }
        Task {
            do {
                let session = try await services.tunnels.setConfig(deviceID, sessionID: sessionID, configID: option.id, value: value)
                state.session = session
            } catch {
                errorMessage = "设置没有生效：\(AppModel.describe(error))"
            }
        }
    }

    func steerQueued(_ item: QueuedMessage) {
        guard let services else { return }
        Task {
            do { try await services.tunnels.steerQueued(deviceID, sessionID: sessionID, clientMsgID: item.clientMsgID) } catch {
                errorMessage = AppModel.describe(error)
            }
        }
    }

    func unqueue(_ item: QueuedMessage) {
        guard let services else { return }
        Task {
            do { try await services.tunnels.unqueue(deviceID, sessionID: sessionID, clientMsgID: item.clientMsgID) } catch {
                errorMessage = AppModel.describe(error)
            }
        }
    }

    func rename(_ title: String) {
        guard let services else { return }
        Task {
            do { state.session = try await services.tunnels.renameSession(deviceID, sessionID: sessionID, title: title) } catch {
                errorMessage = AppModel.describe(error)
            }
        }
    }

    // MARK: Attachments

    /// Upload picked bytes to the device (≤ 8 MiB through the tunnel; larger files need the cloud drive, not yet here).
    func attach(data: Data, name: String, mime: String, preview: UIImage? = nil) {
        guard data.count <= DeviceTunnelPool.maxRPCAttachmentBytes else {
            errorMessage = "「\(name)」超过 8 MiB。大文件经云盘中转还没有接入。"
            return
        }
        var item = DraftAttachment(name: name, mime: mime, size: data.count, preview: preview, state: .uploading)
        attachments.append(item)
        guard let services else { return }
        let id = item.id
        Task {
            do {
                let saved = try await services.tunnels.saveAttachment(deviceID, name: name, data: data, mime: mime)
                item.state = .ready(saved.part)
            } catch {
                item.state = .failed(AppModel.describe(error))
            }
            if let index = attachments.firstIndex(where: { $0.id == id }) { attachments[index].state = item.state }
        }
    }

    func removeAttachment(_ id: UUID) {
        attachments.removeAll { $0.id == id }
    }
}

enum Haptics {
    @MainActor static func play(_ kind: String) {
        switch kind {
        case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
        case "warning": UINotificationFeedbackGenerator().notificationOccurred(.warning)
        default: UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
    }
}
