import PhotosUI
import SwiftUI
import UIKit

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
    @State private var isCameraPickerPresented = false
    @State private var isCameraUnavailable = false
    @State private var isShowingDetails = false
    @State private var isShowingRuntimeSettings = false
    @State private var isApplyingTakeover = false
    @State private var isConfirmingTakeoverBeforeSend = false
    @State private var runtimeSchema: RuntimeConfigSchema?
    @State private var runtimeSettings: RuntimeSettingsResponse?
    @State private var isLoadingRuntimeSettings = false
    @State private var isPatchingRuntimeSettings = false
    @State private var hasPositionedInitialScroll = false
    @State private var sseTask: Task<Void, Never>?
    @State private var pollTask: Task<Void, Never>?

    private var timelineItems: [TimelineItem] {
        let real = itemsById.values.sorted { lhs, rhs in
            lhs.orderSeq == rhs.orderSeq ? lhs.updatedSeq < rhs.updatedSeq : lhs.orderSeq < rhs.orderSeq
        }
        return mergeOptimisticItems(real: real, optimistic: optimisticItems)
    }

    private var displayEntries: [ChatEntry] {
        var entries = timelineItems.compactMap { item -> ChatEntry? in
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
                guard !displayEntries.isEmpty else { return }
                if hasPositionedInitialScroll {
                    scrollToBottom(proxy, animated: true)
                } else {
                    hasPositionedInitialScroll = true
                    scrollToBottom(proxy, animated: false)
                    DispatchQueue.main.async {
                        scrollToBottom(proxy, animated: false)
                    }
                }
            }
            .onChange(of: session.status) { _, _ in
                if hasPositionedInitialScroll {
                    scrollToBottom(proxy, animated: true)
                }
            }
            .task {
                await markRead()
                await loadState(replace: true)
                startEventStream()
                startFallbackPoll()
                scrollToBottom(proxy, animated: false)
                DispatchQueue.main.async {
                    scrollToBottom(proxy, animated: false)
                }
            }
            .onDisappear {
                sseTask?.cancel()
                pollTask?.cancel()
            }
        }
        .navigationTitle(session.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        Task { await applyTakeover() }
                    } label: {
                        Label(session.takeover ? "Disable Takeover" : "Takeover", systemImage: session.takeover ? "lock.open" : "hand.raised")
                    }
                    .disabled(isApplyingTakeover)

                    Button {
                        isShowingDetails = true
                    } label: {
                        Label("Details", systemImage: "info.circle")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                }
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
                    onCamera: { openCamera() },
                    onRuntime: { Task { await openRuntimeSettings() } },
                    isTakeoverEnabled: session.takeover,
                    isTakeoverDisabled: isApplyingTakeover || session.connectorStatus != "online",
                    onToggleTakeover: { Task { await applyTakeover() } },
                )
            }
        }
        .photosPicker(isPresented: photoPickerBinding, selection: $selectedPhotoItems, maxSelectionCount: 4, matching: .images)
        .onChange(of: selectedPhotoItems) { _, items in
            Task { await importPhotos(items) }
        }
        .fullScreenCover(isPresented: $isCameraPickerPresented) {
            CameraImagePicker { image in
                importCameraImage(image)
            }
            .ignoresSafeArea()
        }
        .sheet(isPresented: $isShowingDetails) {
            SessionDetailsSheet(session: session)
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $isShowingRuntimeSettings) {
            RuntimeSettingsSheet(
                session: session,
                schema: runtimeSchema,
                response: runtimeSettings,
                isLoading: isLoadingRuntimeSettings,
                isPatching: isPatchingRuntimeSettings,
                onPatch: { key, value in
                    Task { await patchRuntimeSetting(key: key, value: value) }
                },
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .alert("Camera", isPresented: $isCameraUnavailable) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Camera capture is not available on this device.")
        }
        .alert("Enable Takeover?", isPresented: $isConfirmingTakeoverBeforeSend) {
            Button("Cancel", role: .cancel) {}
            Button("Enable and Send") {
                Task { await enableTakeoverAndSend() }
            }
        } message: {
            Text("This session is read-only until takeover is enabled.")
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

    private func openCamera() {
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            isCameraPickerPresented = true
        } else {
            isCameraUnavailable = true
        }
    }

    private func importCameraImage(_ image: UIImage) {
        guard let data = image.jpegData(compressionQuality: 0.86) else { return }
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        pendingUploads.append(AttachmentUpload(
            name: "camera-\(formatter.string(from: Date())).jpg",
            mediaType: "image/jpeg",
            data: data,
        ))
    }

    private func applyTakeover() async {
        guard !isApplyingTakeover, let api = appState.api, let token = appState.accessToken() else { return }
        isApplyingTakeover = true
        defer { isApplyingTakeover = false }
        do {
            let response = session.takeover
                ? try await api.disableTakeover(token: token, sessionId: initialSession.id)
                : try await api.enableTakeover(token: token, sessionId: initialSession.id)
            session = response.session
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func openRuntimeSettings() async {
        isShowingRuntimeSettings = true
        await loadRuntimeSettings()
    }

    private func loadRuntimeSettings() async {
        guard let api = appState.api, let token = appState.accessToken() else { return }
        isLoadingRuntimeSettings = true
        defer { isLoadingRuntimeSettings = false }
        do {
            async let schemaResponse = api.getRuntimeConfigSchema(token: token, runtime: session.runtime)
            async let settingsResponse = api.getSessionRuntimeSettings(token: token, sessionId: initialSession.id)
            let loadedSchema = try await schemaResponse
            let loadedSettings = try await settingsResponse
            runtimeSchema = loadedSchema.schema
            runtimeSettings = loadedSettings
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func patchRuntimeSetting(key: String, value: JSONValue) async {
        guard let api = appState.api, let token = appState.accessToken() else { return }
        isPatchingRuntimeSettings = true
        defer { isPatchingRuntimeSettings = false }
        do {
            let response = try await api.patchSessionRuntimeSettings(
                token: token,
                sessionId: initialSession.id,
                settings: [key: value],
            )
            runtimeSettings = response
            session = session.updatingRuntimeSettings(from: response)
        } catch {
            errorMessage = error.localizedDescription
        }
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
        guard canSend else { return }
        if !session.takeover {
            isConfirmingTakeoverBeforeSend = true
            return
        }
        await performSendMessage()
    }

    private func enableTakeoverAndSend() async {
        guard canSend, let api = appState.api, let token = appState.accessToken() else { return }
        isApplyingTakeover = true
        defer { isApplyingTakeover = false }
        do {
            let response = try await api.enableTakeover(token: token, sessionId: initialSession.id)
            session = response.session
            await performSendMessage()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func performSendMessage() async {
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

    @State private var isExpanded = false

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
                    messageTextView
                }
                if item.status == "pending" || item.status == "failed" {
                    Text(item.status == "failed" ? "Failed to send" : "Sending...")
                        .font(.caption2)
                        .foregroundStyle(statusColor)
                }
            }
            .frame(maxWidth: isUser ? 300 : .infinity, alignment: isUser ? .trailing : .leading)

        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private var messageTextView: some View {
        if isUser {
            VStack(alignment: .leading, spacing: 8) {
                Text(text)
                    .font(.body)
                    .lineLimit(isExpanded ? nil : 10)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)

                if shouldCollapse {
                    Button(isExpanded ? "Show Less" : "Show More") {
                        withAnimation(.snappy(duration: 0.2)) {
                            isExpanded.toggle()
                        }
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.78))
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color(.sRGB, white: 0.18, opacity: 1))
            }
            .foregroundStyle(.white)
        } else {
            MarkdownText(text: text)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var shouldCollapse: Bool {
        text.components(separatedBy: .newlines).count > 10 || text.count > 700
    }

    private var statusColor: Color {
        return item.status == "failed" ? .red : .secondary
    }
}

private struct MarkdownText: View {
    let text: String

    var body: some View {
        Text(attributed)
            .font(.body)
            .foregroundStyle(.primary)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var attributed: AttributedString {
        (try? AttributedString(markdown: text))
            ?? AttributedString(text)
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
    }
}

private struct SessionDetailsSheet: View {
    let session: SessionSummary

    var body: some View {
        NavigationStack {
            List {
                Section("Session") {
                    DetailRow("Title", session.displayTitle)
                    DetailRow("Status", session.status.capitalized)
                    DetailRow("Takeover", session.takeover ? "Enabled" : "Disabled")
                    if let cwd = session.cwd, !cwd.isEmpty {
                        DetailRow("Directory", cwd)
                    }
                }

                Section("Runtime") {
                    DetailRow("Agent", session.runtime)
                    DetailRow("Connector", session.connectorId)
                    DetailRow("Connector Status", session.connectorStatus.capitalized)
                    if let runMode = session.effectiveRunMode, !runMode.isEmpty {
                        DetailRow("Run Mode", runMode)
                    }
                }

                Section("Activity") {
                    if let lastActivityAt = session.lastActivityAt {
                        DetailRow("Last Activity", lastActivityAt)
                    }
                    if let lastSyncedAt = session.lastSyncedAt {
                        DetailRow("Last Synced", lastSyncedAt)
                    }
                    DetailRow("Updated Seq", "\(session.updatedSeq)")
                }
            }
            .navigationTitle("Details")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

private struct DetailRow: View {
    let title: String
    let value: String

    init(_ title: String, _ value: String) {
        self.title = title
        self.value = value
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .foregroundStyle(.secondary)
            Spacer(minLength: 16)
            Text(value)
                .multilineTextAlignment(.trailing)
        }
    }
}

private struct RuntimeSettingsSheet: View {
    let session: SessionSummary
    let schema: RuntimeConfigSchema?
    let response: RuntimeSettingsResponse?
    let isLoading: Bool
    let isPatching: Bool
    let onPatch: (String, JSONValue) -> Void

    private var settings: [String: JSONValue] {
        guard let settingsValue = response?.settings,
              case let .object(object) = settingsValue
        else { return [:] }
        return object
    }

    private var fields: [RuntimeConfigField] {
        schema?.fields.filter { field in
            field.hidden != true
                && field.allowSessionOverride
                && ["enum", "boolean"].contains(field.type)
                && isVisible(field)
        } ?? []
    }

    var body: some View {
        NavigationStack {
            List {
                if isLoading && response == nil {
                    ProgressView()
                        .frame(maxWidth: .infinity, alignment: .center)
                } else if fields.isEmpty {
                    ContentUnavailableView(
                        "No Runtime Settings",
                        systemImage: "slider.horizontal.3",
                        description: Text("This agent does not expose session-level settings."),
                    )
                } else {
                    Section {
                        ForEach(fields) { field in
                            RuntimeSettingRow(
                                field: field,
                                value: settings[field.key],
                                isDisabled: isPatching,
                                onPatch: onPatch,
                            )
                        }
                    } footer: {
                        if isPatching {
                            HStack(spacing: 8) {
                                ProgressView()
                                Text("Saving")
                            }
                        }
                    }
                }
            }
            .navigationTitle("\(session.runtime.capitalized) Runtime")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func isVisible(_ field: RuntimeConfigField) -> Bool {
        guard let visibleWhen = field.visibleWhen,
              case let .object(conditions) = visibleWhen
        else { return true }
        for (key, expected) in conditions {
            if settings[key] != expected {
                return false
            }
        }
        return true
    }
}

private struct RuntimeSettingRow: View {
    let field: RuntimeConfigField
    let value: JSONValue?
    let isDisabled: Bool
    let onPatch: (String, JSONValue) -> Void

    var body: some View {
        if field.type == "boolean" {
            Toggle(isOn: booleanBinding) {
                label
            }
            .disabled(isDisabled)
        } else {
            Picker(selection: selectionBinding) {
                ForEach(field.options ?? []) { option in
                    Text(option.label)
                        .tag(option.value.stringValue ?? option.label)
                }
            } label: {
                label
            }
            .disabled(isDisabled)
        }
    }

    private var label: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(field.label)
            if let description = field.description, !description.isEmpty {
                Text(description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var selectionBinding: Binding<String> {
        Binding(
            get: {
                value?.stringValue ?? firstOptionValue
            },
            set: { newValue in
                guard newValue != value?.stringValue else { return }
                onPatch(field.key, optionValue(for: newValue))
            },
        )
    }

    private var booleanBinding: Binding<Bool> {
        Binding(
            get: {
                if case let .bool(current) = value {
                    return current
                }
                return false
            },
            set: { newValue in
                onPatch(field.key, .bool(newValue))
            },
        )
    }

    private var firstOptionValue: String {
        field.options?.first?.value.stringValue ?? ""
    }

    private func optionValue(for selected: String) -> JSONValue {
        field.options?.first { ($0.value.stringValue ?? $0.label) == selected }?.value ?? .string(selected)
    }
}

struct LiquidGlassMessageInputBar: View {
    @Binding var text: String

    var isSending = false
    var hasPendingAttachments = false
    var onSend: () -> Void
    var onPlus: () -> Void = {}
    var onCamera: () -> Void = {}
    var onRuntime: () -> Void = {}
    var isTakeoverEnabled = false
    var isTakeoverDisabled = false
    var onToggleTakeover: () -> Void = {}

    @FocusState private var isFocused: Bool

    private var canSend: Bool {
        return !isSending && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hasPendingAttachments)
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            plusButton

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 10) {
                    Label(isTakeoverEnabled ? "Takeover" : "Read-only", systemImage: isTakeoverEnabled ? "lock.open" : "lock")
                    Button {
                        onRuntime()
                    } label: {
                        Label("Runtime", systemImage: "terminal")
                    }
                    .buttonStyle(.plain)
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)

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
                        }
                    } label: {
                        if isSending {
                            ProgressView()
                                .scaleEffect(0.78)
                                .frame(width: 30, height: 30)
                        } else {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.title2)
                                .symbolRenderingMode(.hierarchical)
                                .foregroundStyle(sendIconShapeStyle)
                                .frame(width: 30, height: 30)
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSend)
                    .accessibilityLabel("Send")
                }
            }
            .frame(minHeight: 44)
            .padding(.leading, 15)
            .padding(.trailing, 8)
            .background {
                inputGlassBackground
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 8)
    }

    private var plusButton: some View {
        Menu {
            Button {
                onPlus()
            } label: {
                Label("Photos", systemImage: "photo")
            }

            Button {
                onCamera()
            } label: {
                Label("Camera", systemImage: "camera")
            }

            Button {
                onRuntime()
            } label: {
                Label("Runtime", systemImage: "terminal")
            }

            Toggle(isOn: takeoverBinding) {
                Label("Takeover", systemImage: "hand.raised")
            }
            .disabled(isTakeoverDisabled)
        } label: {
            Image(systemName: "plus")
                .font(.title3)
                .fontWeight(.medium)
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(CircularGlassButtonStyle())
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

    private var sendIconShapeStyle: AnyShapeStyle {
        if canSend {
            return AnyShapeStyle(.tint)
        }
        return AnyShapeStyle(.secondary)
    }

    private var takeoverBinding: Binding<Bool> {
        Binding(
            get: { isTakeoverEnabled },
            set: { newValue in
                guard newValue != isTakeoverEnabled else { return }
                onToggleTakeover()
            },
        )
    }
}

private struct CircularGlassButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background {
                if #available(iOS 26.0, *) {
                    Circle()
                        .fill(.clear)
                        .glassEffect(.regular, in: Circle())
                } else {
                    Circle()
                        .fill(.regularMaterial)
                }
            }
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
    }
}

private struct CameraImagePicker: UIViewControllerRepresentable {
    @Environment(\.dismiss) private var dismiss

    let onImage: (UIImage) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = .camera
        controller.delegate = context.coordinator
        controller.modalPresentationStyle = .fullScreen
        controller.view.backgroundColor = .black
        return controller
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        private let parent: CameraImagePicker

        init(parent: CameraImagePicker) {
            self.parent = parent
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any],
        ) {
            if let image = info[.originalImage] as? UIImage {
                parent.onImage(image)
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
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

    func updatingRuntimeSettings(from response: RuntimeSettingsResponse) -> SessionSummary {
        SessionSummary(
            id: id,
            connectorId: connectorId,
            runtime: runtime,
            externalSessionId: externalSessionId,
            title: title,
            cwd: cwd,
            status: status,
            connectorStatus: connectorStatus,
            takeover: takeover,
            archived: archived,
            pinned: pinned,
            unread: unread,
            lastReadSeq: lastReadSeq,
            lastSyncedAt: lastSyncedAt,
            sourceObservedAt: sourceObservedAt,
            lastActivityAt: lastActivityAt,
            lastItemAt: lastItemAt,
            lastItemOrderSeq: lastItemOrderSeq,
            sortAt: sortAt,
            updatedSeq: updatedSeq,
            effectiveRunMode: response.effectiveRunMode ?? effectiveRunMode,
            runtimeSettings: response.runtimeSettings ?? response.settings,
            runtimeSettingsOverride: response.runtimeSettingsOverride,
        )
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
