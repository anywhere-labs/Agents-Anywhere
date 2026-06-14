import AVFoundation
import Combine
import PhotosUI
import Speech
import SwiftUI

private let attachmentOnlyPrompt = "Please review the attached file."

struct SessionDetailView: View {
    @EnvironmentObject private var appState: AppState

    let initialSession: SessionSummary

    @State private var session: SessionSummary
    @State private var itemsById: [String: TimelineItem] = [:]
    @State private var approvals: [Approval] = []
    @State private var optimisticItems: [TimelineItem] = []
    @State private var nextSeq = 0
    @State private var isLoading = true
    @State private var isSending = false
    @State private var messageText = ""
    @State private var errorMessage: String?
    @State private var selectedPhotoItems: [PhotosPickerItem] = []
    @State private var pendingUploads: [AttachmentUpload] = []
    @State private var isPhotoPickerPresented = false
    @State private var sseTask: Task<Void, Never>?
    @State private var pollTask: Task<Void, Never>?

    private var timelineItems: [TimelineItem] {
        let real = itemsById.values.sorted { lhs, rhs in
            lhs.orderSeq == rhs.orderSeq ? lhs.updatedSeq < rhs.updatedSeq : lhs.orderSeq < rhs.orderSeq
        }
        return mergeOptimisticItems(real: real, optimistic: optimisticItems)
    }

    private var displayEntries: [ChatEntry] {
        var entries = timelineItems.compactMap { item in
            if item.type == "message", item.role == "user" || item.role == "assistant" {
                return .message(item)
            }
            if item.type == "system", item.status == "failed" {
                return .notice("Error", item.displayText ?? "Runtime error")
            }
            return nil
        }
        entries.append(contentsOf: approvals.filter { $0.status == "pending" }.map(ChatEntry.approval))
        return entries.sorted { lhs, rhs in
            lhs.sortKey < rhs.sortKey
        }
    }

    private var canSend: Bool {
        return !messageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingUploads.isEmpty
    }

    init(initialSession: SessionSummary) {
        self.initialSession = initialSession
        _session = State(initialValue: initialSession)
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if isLoading && displayEntries.isEmpty {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 60)
                    } else if displayEntries.isEmpty {
                        ContentUnavailableView(
                            "No Messages Yet",
                            systemImage: "bubble.left.and.bubble.right",
                            description: Text("Messages from this session will appear here."),
                        )
                        .padding(.top, 80)
                    } else {
                        ForEach(displayEntries) { entry in
                            ChatEntryView(entry: entry)
                                .id(entry.id)
                        }

                        if session.status == "running" {
                            WorkingIndicator(runtime: session.runtime)
                                .id("working")
                        }
                    }

                    Color.clear
                        .frame(height: 1)
                        .id("bottom")
                }
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, pendingUploads.isEmpty ? 92 : 138)
            }
            .defaultScrollAnchor(.bottom)
            .onChange(of: displayEntries.last?.id) { _, _ in
                scrollToBottom(proxy, animated: true)
            }
            .onChange(of: session.status) { _, _ in
                scrollToBottom(proxy, animated: true)
            }
            .task {
                await markRead()
                await loadState(replace: true)
                startEventStream()
                startFallbackPoll()
                scrollToBottom(proxy, animated: false)
            }
            .onDisappear {
                sseTask?.cancel()
                pollTask?.cancel()
            }
        }
        .navigationTitle(session.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await loadState(replace: true) }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(isLoading)
            }
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 0) {
                if !pendingUploads.isEmpty {
                    AttachmentStrip(uploads: pendingUploads) { upload in
                        pendingUploads.removeAll { $0 == upload }
                    }
                }
                LiquidGlassMessageInputBar(
                    text: $messageText,
                    isSending: isSending,
                    hasPendingAttachments: !pendingUploads.isEmpty,
                    onSend: { Task { await sendMessage() } },
                    onPlus: { isPhotoPickerPresented = true },
                )
            }
        }
        .photosPicker(isPresented: photoPickerBinding, selection: $selectedPhotoItems, maxSelectionCount: 4, matching: .images)
        .onChange(of: selectedPhotoItems) { _, items in
            Task { await importPhotos(items) }
        }
        .alert("Session Error", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } },
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "Something went wrong.")
        }
    }

    private var photoPickerBinding: Binding<Bool> {
        Binding(
            get: { isPhotoPickerPresented },
            set: { isPhotoPickerPresented = $0 },
        )
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
        let action = { proxy.scrollTo("bottom", anchor: .bottom) }
        if animated {
            withAnimation(.easeOut(duration: 0.22), action)
        } else {
            action()
        }
    }

    private func markRead() async {
        guard initialSession.unread, let api = appState.api, let token = appState.accessToken() else { return }
        _ = try? await api.markSessionRead(token: token, sessionId: initialSession.id)
    }

    private func loadState(replace: Bool) async {
        guard let api = appState.api, let token = appState.accessToken() else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            var afterSeq = replace ? 0 : nextSeq
            var collected: [TimelineItem] = []
            var latestApprovals: [Approval]?
            var latestSession: SessionSummary?
            var latestNextSeq = nextSeq
            var hasMore = true

            while hasMore {
                let response = try await api.getSessionState(
                    token: token,
                    sessionId: initialSession.id,
                    afterSeq: afterSeq,
                    limit: 500,
                )
                collected.append(contentsOf: response.items)
                latestApprovals = response.approvals
                latestSession = response.session
                latestNextSeq = max(latestNextSeq, response.nextSeq)
                hasMore = response.hasMore

                guard let last = response.items.last, last.updatedSeq > afterSeq else {
                    break
                }
                afterSeq = last.updatedSeq
            }

            applyDelta(
                items: collected,
                approvals: latestApprovals,
                session: latestSession,
                nextSeq: latestNextSeq,
                replaceItems: replace,
            )
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func startEventStream() {
        sseTask?.cancel()
        guard let api = appState.api, let token = appState.accessToken() else { return }
        sseTask = Task {
            do {
                let url = try api.sessionEventsURL(token: token, sessionId: initialSession.id)
                let (bytes, _) = try await URLSession.shared.bytes(from: url)
                for try await line in bytes.lines {
                    guard !Task.isCancelled else { return }
                    guard line.hasPrefix("data:") else { continue }
                    let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                    guard let data = payload.data(using: .utf8) else { continue }
                    if let event = try? JSONDecoder().decode(SessionEventEnvelope.self, from: data) {
                        await MainActor.run {
                            if event.refetch == true {
                                Task { await loadState(replace: true) }
                            } else {
                                applyDelta(
                                    items: event.items ?? [],
                                    approvals: event.approvals,
                                    session: event.session,
                                    nextSeq: event.nextSeq,
                                    replaceItems: false,
                                )
                            }
                        }
                    }
                }
            } catch {
                // Fallback polling keeps the session live when an environment
                // buffers or rejects event streams.
            }
        }
    }

    private func startFallbackPoll() {
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled else { return }
                await loadState(replace: false)
            }
        }
    }

    private func applyDelta(
        items newItems: [TimelineItem],
        approvals newApprovals: [Approval]?,
        session newSession: SessionSummary?,
        nextSeq newNextSeq: Int?,
        replaceItems: Bool,
    ) {
        if replaceItems {
            itemsById = [:]
        }
        for item in newItems {
            let existing = itemsById[item.id]
            if existing == nil || existing!.updatedSeq <= item.updatedSeq {
                itemsById[item.id] = item
            }
        }
        if let newApprovals {
            approvals = newApprovals
        }
        if let newSession {
            session = newSession
        }
        if let newNextSeq {
            nextSeq = max(nextSeq, newNextSeq)
        }
        pruneOptimisticItems()
    }

    private func sendMessage() async {
        guard canSend, let api = appState.api, let token = appState.accessToken() else { return }
        let visibleText = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
        let uploads = pendingUploads
        let tempId = "opt_\(UUID().uuidString)"
        let now = ISO8601DateFormatter().string(from: Date())

        isSending = true
        do {
            let uploaded = uploads.isEmpty
                ? []
                : try await api.uploadSessionAttachments(token: token, sessionId: initialSession.id, uploads: uploads).attachments
            let sendContent = visibleText.isEmpty && !uploaded.isEmpty ? attachmentOnlyPrompt : visibleText
            let optimistic = TimelineItem.optimisticUserMessage(
                id: tempId,
                sessionId: initialSession.id,
                text: visibleText,
                attachments: uploaded,
                createdAt: now,
            )
            optimisticItems.append(optimistic)
            messageText = ""
            pendingUploads = []

            _ = try await api.sendSessionMessage(
                token: token,
                sessionId: initialSession.id,
                content: sendContent,
                attachments: uploaded.map { AttachmentRef(fileId: $0.fileId) },
                clientMessageId: tempId,
            )

            optimisticItems = optimisticItems.map {
                $0.id == tempId ? $0.withStatus("running") : $0
            }
            errorMessage = nil
        } catch {
            optimisticItems = optimisticItems.map {
                $0.id == tempId ? $0.withStatus("failed") : $0
            }
            errorMessage = error.localizedDescription
        }
        isSending = false
    }

    private func importPhotos(_ items: [PhotosPickerItem]) async {
        defer { selectedPhotoItems = [] }
        for item in items {
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else { continue }
                let upload = AttachmentUpload(
                    name: "photo-\(UUID().uuidString.prefix(8)).jpg",
                    mediaType: "image/jpeg",
                    data: data,
                )
                pendingUploads.append(upload)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func pruneOptimisticItems() {
        optimisticItems.removeAll { optimistic in
            guard optimistic.status != "failed" else { return false }
            return itemsById.values.contains { $0.matchesOptimisticMessage(optimistic.id) }
        }
    }
}

private enum ChatEntry: Identifiable {
    case message(TimelineItem)
    case approval(Approval)
    case notice(String, String)

    var id: String {
        switch self {
        case let .message(item):
            return item.id
        case let .approval(approval):
            return approval.id
        case let .notice(kind, text):
            return "\(kind)-\(text)"
        }
    }

    var sortKey: Int {
        switch self {
        case let .message(item):
            return item.orderSeq
        case let .approval(approval):
            return approval.updatedSeq
        case .notice:
            return Int.max
        }
    }

}

private struct ChatEntryView: View {
    let entry: ChatEntry

    var body: some View {
        switch entry {
        case let .message(item):
            MessageBubble(item: item)
        case let .approval(approval):
            ApprovalSummary(approval: approval)
        case let .notice(kind, text):
            NoticeRow(kind: kind, text: text)
        }
    }
}

private struct MessageBubble: View {
    let item: TimelineItem

    private var isUser: Bool { return item.role == "user" }
    private var text: String { return item.displayText ?? "" }
    private var attachments: [UploadedAttachment] { return item.attachments }

    var body: some View {
        HStack(alignment: .bottom) {
            if isUser { Spacer(minLength: 48) }

            VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
                if !attachments.isEmpty {
                    AttachmentPreviewGrid(attachments: attachments)
                }
                if !text.isEmpty {
                    Text(text)
                        .font(.body)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, isUser ? 14 : 0)
                        .padding(.vertical, isUser ? 10 : 0)
                        .background {
                            if isUser {
                                RoundedRectangle(cornerRadius: 18, style: .continuous)
                                    .fill(.tint)
                            }
                        }
                        .foregroundStyle(textColor)
                }
                if item.status == "pending" || item.status == "failed" {
                    Text(item.status == "failed" ? "Failed to send" : "Sending...")
                        .font(.caption2)
                        .foregroundStyle(statusColor)
                }
            }
            .frame(maxWidth: isUser ? 300 : .infinity, alignment: isUser ? .trailing : .leading)

            if !isUser { Spacer(minLength: 32) }
        }
        .frame(maxWidth: .infinity)
    }

    private var textColor: Color {
        return isUser ? .white : .primary
    }

    private var statusColor: Color {
        return item.status == "failed" ? .red : .secondary
    }
}

private struct AttachmentPreviewGrid: View {
    let attachments: [UploadedAttachment]

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            ForEach(attachments) { attachment in
                HStack(spacing: 6) {
                    Image(systemName: attachment.mediaType.hasPrefix("image/") ? "photo" : "paperclip")
                    Text(attachment.name)
                        .lineLimit(1)
                }
                .font(.caption)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background {
                    Capsule(style: .continuous)
                        .fill(.secondary.opacity(0.12))
                }
            }
        }
    }
}

private struct ApprovalSummary: View {
    let approval: Approval

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Approval Required", systemImage: "checkmark.shield")
                .font(.subheadline.weight(.semibold))
            Text(approval.title)
                .font(.headline)
            if let description = approval.description, !description.isEmpty {
                Text(description)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.orange.opacity(0.14))
        }
    }
}

private struct NoticeRow: View {
    let kind: String
    let text: String

    var body: some View {
        Label {
            Text(text)
                .lineLimit(3)
        } icon: {
            Image(systemName: "exclamationmark.triangle")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.vertical, 4)
    }
}

private struct WorkingIndicator: View {
    let runtime: String

    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
                .scaleEffect(0.72)
            Text("\(runtime) is working...")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct AttachmentStrip: View {
    let uploads: [AttachmentUpload]
    let onRemove: (AttachmentUpload) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(uploads, id: \.id) { upload in
                    HStack(spacing: 6) {
                        Image(systemName: upload.mediaType.hasPrefix("image/") ? "photo" : "paperclip")
                        Text(upload.name)
                            .lineLimit(1)
                        Button {
                            onRemove(upload)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                        }
                        .buttonStyle(.plain)
                    }
                    .font(.caption)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background {
                        Capsule(style: .continuous)
                            .fill(.regularMaterial)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
        }
        .background(.bar)
    }
}

struct LiquidGlassMessageInputBar: View {
    @Binding var text: String

    var isSending = false
    var hasPendingAttachments = false
    var onSend: () -> Void
    var onPlus: () -> Void = {}

    @FocusState private var isFocused: Bool
    @StateObject private var speech = SpeechInputController()

    private var canSend: Bool {
        return !isSending && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hasPendingAttachments)
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            plusButton

            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message", text: $text, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.plain)
                    .focused($isFocused)
                    .submitLabel(.send)
                    .onSubmit {
                        if canSend {
                            onSend()
                        }
                    }

                Button {
                    if canSend {
                        onSend()
                    } else {
                        toggleDictation()
                    }
                } label: {
                    if isSending {
                        ProgressView()
                            .scaleEffect(0.78)
                            .frame(width: 30, height: 30)
                    } else {
                        Image(systemName: canSend ? "arrow.up.circle.fill" : speech.isRecording ? "stop.circle.fill" : "mic.fill")
                            .font(.title2)
                            .symbolRenderingMode(.hierarchical)
                            .foregroundStyle(sendIconShapeStyle)
                            .frame(width: 30, height: 30)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(canSend ? "Send" : speech.isRecording ? "Stop Dictation" : "Voice Input")
            }
            .padding(.leading, 15)
            .padding(.trailing, 8)
            .padding(.vertical, 8)
            .background {
                inputGlassBackground
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .background(.bar)
        .onChange(of: speech.transcript) { _, newValue in
            text = newValue
        }
    }

    private var plusButton: some View {
        Menu {
            Button {
                onPlus()
            } label: {
                Label("Photos", systemImage: "photo")
            }

            Button {
            } label: {
                Label("Camera", systemImage: "camera")
            }

            Button {
            } label: {
                Label("Files", systemImage: "folder")
            }

            Button {
            } label: {
                Label("Runtime", systemImage: "terminal")
            }
        } label: {
            Image(systemName: "plus")
                .font(.title3)
                .fontWeight(.medium)
                .frame(width: 36, height: 36)
        }
        .buttonStyle(.glass)
        .accessibilityLabel("More Content")
    }

    @ViewBuilder
    private var inputGlassBackground: some View {
        if #available(iOS 26.0, *) {
            Capsule(style: .continuous)
                .fill(.clear)
                .glassEffect(.regular, in: Capsule(style: .continuous))
        } else {
            Capsule(style: .continuous)
                .fill(.regularMaterial)
        }
    }

    private func toggleDictation() {
        isFocused = false
        if speech.isRecording {
            speech.stop()
        } else {
            speech.start()
        }
    }

    private var sendIconShapeStyle: AnyShapeStyle {
        if canSend {
            return AnyShapeStyle(.tint)
        }
        if speech.isRecording {
            return AnyShapeStyle(Color.red)
        }
        return AnyShapeStyle(.secondary)
    }
}

@MainActor
final class SpeechInputController: ObservableObject {
    @Published var transcript = ""
    @Published var isRecording = false

    private let recognizer = SFSpeechRecognizer()
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    func start() {
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            guard status == .authorized else { return }
            Task { @MainActor in self?.startRecording() }
        }
    }

    func stop() {
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        isRecording = false
    }

    private func startRecording() {
        stop()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        self.request = request

        do {
            #if os(iOS)
            try AVAudioSession.sharedInstance().setCategory(.record, mode: .measurement, options: .duckOthers)
            try AVAudioSession.sharedInstance().setActive(true, options: .notifyOthersOnDeactivation)
            #endif
            let node = audioEngine.inputNode
            let format = node.outputFormat(forBus: 0)
            try node.installSpeechTap(onBus: 0, bufferSize: 1024, format: format) { [weak request] buffer, _ in
                request?.append(buffer)
            }
            audioEngine.prepare()
            try audioEngine.start()
            isRecording = true
        } catch {
            stop()
            return
        }

        task = recognizer?.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                if let result {
                    self?.transcript = result.bestTranscription.formattedString
                }
                if error != nil || result?.isFinal == true {
                    self?.stop()
                }
            }
        }
    }
}

private extension AVAudioNode {
    func installSpeechTap(
        onBus bus: AVAudioNodeBus,
        bufferSize: AVAudioFrameCount,
        format: AVAudioFormat?,
        block: @escaping AVAudioNodeTapBlock,
    ) throws {
        if #available(iOS 27.0, macOS 27.0, tvOS 27.0, watchOS 27.0, *) {
            try installTap(onBus: bus, bufferSize: bufferSize, format: format, block: block)
        } else {
            installTap(onBus: bus, bufferSize: bufferSize, format: format, block: block)
        }
    }
}

private struct SessionEventEnvelope: Decodable {
    let items: [TimelineItem]?
    let approvals: [Approval]?
    let session: SessionSummary?
    let nextSeq: Int?
    let refetch: Bool?
}

extension SessionSummary {
    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        return cwd ?? id
    }

    var runtimeIcon: String {
        runtime.localizedCaseInsensitiveContains("claude") ? "sparkles" : "terminal"
    }

    var sortKey: String {
        return sortAt ?? lastActivityAt ?? lastItemAt ?? ""
    }

    func isMoreRecent(than other: SessionSummary) -> Bool {
        let sortComparison = sortKey.compare(other.sortKey)
        if sortComparison != .orderedSame {
            return sortComparison == .orderedDescending
        }

        let orderSeq = lastItemOrderSeq ?? -1
        let otherOrderSeq = other.lastItemOrderSeq ?? -1
        if orderSeq != otherOrderSeq {
            return orderSeq > otherOrderSeq
        }

        return updatedSeq > other.updatedSeq
    }

    var statusLabel: String {
        switch status {
        case "running":
            return "Running"
        case "waiting_approval":
            return "Approval"
        case "error":
            return "Error"
        case "idle":
            return "Idle"
        default:
            return status.capitalized
        }
    }

    var displayTime: String {
        guard let date = activityDate else { return "" }
        let interval = Date().timeIntervalSince(date)
        if interval < 60 {
            return "now"
        }
        if interval < 60 * 60 {
            return "\(Int(interval / 60))m"
        }
        if interval < 60 * 60 * 24 {
            return "\(Int(interval / 3_600))h"
        }
        if interval < 60 * 60 * 24 * 7 {
            return "\(Int(interval / 86_400))d"
        }
        return Self.shortDateFormatter.string(from: date)
    }

    private var activityDate: Date? {
        let value = lastActivityAt ?? lastItemAt ?? sortAt
        guard let value else { return nil }
        return Self.isoDateFormatter.date(from: value)
            ?? Self.fractionalISODateFormatter.date(from: value)
    }

    private static let isoDateFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let fractionalISODateFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let shortDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .none
        return formatter
    }()
}

private extension TimelineItem {
    var displayText: String? {
        content["text"]?.stringValue
            ?? content["rawText"]?.stringValue
            ?? content["message"]?.stringValue
            ?? content["summary"]?.stringValue
    }

    var attachments: [UploadedAttachment] {
        guard case let .array(values) = content["attachments"] else { return [] }
        return values.compactMap { value in
            guard case let .object(object) = value,
                  let fileId = object["fileId"]?.stringValue,
                  let name = object["name"]?.stringValue,
                  let mediaType = object["mediaType"]?.stringValue
            else { return nil }
            let size = object["size"]?.intValue ?? 0
            return UploadedAttachment(
                fileId: fileId,
                sessionId: object["sessionId"]?.stringValue ?? sessionId,
                name: name,
                mediaType: mediaType,
                size: size,
                createdAt: object["createdAt"]?.stringValue ?? createdAt,
                downloadUrl: object["downloadUrl"]?.stringValue,
                platformOpenUrl: object["platformOpenUrl"]?.stringValue,
            )
        }
    }

    func matchesOptimisticMessage(_ optimisticId: String) -> Bool {
        if source["clientMessageId"]?.stringValue == optimisticId {
            return true
        }
        return false
    }

    static func optimisticUserMessage(
        id: String,
        sessionId: String,
        text: String,
        attachments: [UploadedAttachment],
        createdAt: String,
    ) -> TimelineItem {
        let content: JSONValue
        if attachments.isEmpty {
            content = .object(["text": .string(text)])
        } else {
            content = .object([
                "text": .string(text),
                "attachments": .array(attachments.map { attachment in
                    .object([
                        "fileId": .string(attachment.fileId),
                        "sessionId": .string(attachment.sessionId),
                        "name": .string(attachment.name),
                        "mediaType": .string(attachment.mediaType),
                        "size": .number(Double(attachment.size)),
                        "createdAt": .string(attachment.createdAt),
                    ])
                }),
            ])
        }
        return TimelineItem(
            id: id,
            sessionId: sessionId,
            turnId: nil,
            type: "message",
            status: "pending",
            role: "user",
            content: content,
            source: .object(["clientMessageId": .string(id)]),
            orderSeq: Int.max,
            revision: 0,
            contentHash: "",
            updatedSeq: 0,
            createdAt: createdAt,
            updatedAt: createdAt,
            completedAt: nil,
        )
    }

    func withStatus(_ status: String) -> TimelineItem {
        TimelineItem(
            id: id,
            sessionId: sessionId,
            turnId: turnId,
            type: type,
            status: status,
            role: role,
            content: content,
            source: source,
            orderSeq: orderSeq,
            revision: revision,
            contentHash: contentHash,
            updatedSeq: updatedSeq,
            createdAt: createdAt,
            updatedAt: updatedAt,
            completedAt: completedAt,
        )
    }
}

private func mergeOptimisticItems(real: [TimelineItem], optimistic: [TimelineItem]) -> [TimelineItem] {
    let realClientIds = Set(real.compactMap { $0.source["clientMessageId"]?.stringValue })
    return real + optimistic.filter { !realClientIds.contains($0.id) }
}

private extension JSONValue {
    var intValue: Int? {
        switch self {
        case let .number(value):
            return Int(value)
        case let .string(value):
            return Int(value) ?? Double(value).map(Int.init)
        default:
            return nil
        }
    }
}
