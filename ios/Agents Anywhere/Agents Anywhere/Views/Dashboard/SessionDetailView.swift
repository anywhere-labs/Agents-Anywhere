import PhotosUI
import MarkdownUI
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
    @State private var isInterrupting = false
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
    @State private var resolvingApprovalId: String?
    @State private var resolvingApprovalStatus: ApprovalResolveStatus?
    @State private var takeoverIntent: TakeoverIntent?
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
        let pendingApprovals = approvals.filter { $0.status == "pending" }
        let approvalsByTarget = Dictionary(
            pendingApprovals.compactMap { approval -> (String, Approval)? in
                guard let targetItemId = approval.targetItemId else { return nil }
                return (targetItemId, approval)
            },
            uniquingKeysWith: { first, _ in first },
        )
        var entries = timelineItems.compactMap { item -> ChatEntry? in
            if item.type == "message", item.role == "user" || item.role == "assistant" {
                return .message(item)
            }
            if item.type == "tool" {
                return .tool(item, approvalsByTarget[item.id])
            }
            if item.type == "artifact" {
                if item.kind == "diff" { return nil }
                return .artifact(item)
            }
            if item.type == "system" {
                return .system(item)
            }
            return nil
        }
        entries.append(contentsOf: pendingApprovals.filter { $0.targetItemId == nil }.map(ChatEntry.approval))
        return entries.sorted { lhs, rhs in
            lhs.sortKey < rhs.sortKey
        }
    }

    private var canSend: Bool {
        return !messageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingUploads.isEmpty
    }

    private var serverBusy: Bool {
        session.status == "running" || session.status == "waiting_approval"
    }

    private var isBusy: Bool {
        serverBusy && !isInterrupting
    }

    private var takeoverConfirmBinding: Binding<Bool> {
        Binding(
            get: { takeoverIntent != nil },
            set: { isPresented in
                if !isPresented, !isApplyingTakeover {
                    takeoverIntent = nil
                }
            },
        )
    }

    private var takeoverAlertTitle: String {
        takeoverIntent == .disable ? "Disable Takeover?" : "Enable Takeover?"
    }

    private var takeoverAlertMessage: String {
        if takeoverIntent == .disable {
            return "Disabling takeover returns this session to read-only mode. Existing agent work keeps running unless you interrupt it first."
        }
        return "Takeover makes this session writable from this iPhone. Messages and interrupts will be sent to the remote agent."
    }

    private var takeoverConfirmTitle: String {
        if isApplyingTakeover {
            return "Applying..."
        }
        return takeoverIntent == .disable ? "Disable Takeover" : "Enable Takeover"
    }

    private var sessionTakeoverBinding: Binding<Bool> {
        Binding(
            get: { session.takeover },
            set: { newValue in
                if newValue != session.takeover {
                    requestTakeoverToggle()
                }
            },
        )
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
                            ChatEntryView(
                                entry: entry,
                                api: appState.api,
                                token: appState.accessToken(),
                                resolvingApprovalId: resolvingApprovalId,
                                resolvingApprovalStatus: resolvingApprovalStatus,
                                onResolveApproval: { approval, status in
                                    Task { await resolveApproval(approval, status: status) }
                                },
                            )
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
                .padding(.bottom, pendingUploads.isEmpty ? 104 : 188)
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
                if isInterrupting && !serverBusy {
                    isInterrupting = false
                }
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
                    Toggle(isOn: sessionTakeoverBinding) {
                        Label("Takeover", systemImage: "hand.raised")
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
                    isBusy: isBusy,
                    hasPendingAttachments: !pendingUploads.isEmpty,
                    canSendMessage: session.connectorStatus == "online" && session.takeover && (session.status == "idle" || session.status == "error"),
                    onSend: { Task { await sendMessage() } },
                    onInterrupt: { Task { await interruptSession() } },
                    onPlus: { isPhotoPickerPresented = true },
                    onCamera: { openCamera() },
                    onRuntime: { Task { await openRuntimeSettings() } },
                    isTakeoverEnabled: session.takeover,
                    isTakeoverDisabled: isApplyingTakeover || session.connectorStatus != "online",
                    onToggleTakeover: { requestTakeoverToggle() },
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
        .alert(takeoverAlertTitle, isPresented: takeoverConfirmBinding) {
            Button("Cancel", role: .cancel) {
                takeoverIntent = nil
            }
            Button(takeoverConfirmTitle) {
                Task { await applyTakeover() }
            }
            .disabled(isApplyingTakeover)
        } message: {
            Text(takeoverAlertMessage)
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
        defer {
            isApplyingTakeover = false
            takeoverIntent = nil
        }
        do {
            let response = session.takeover
                ? try await api.disableTakeover(token: token, sessionId: initialSession.id)
                : try await api.enableTakeover(token: token, sessionId: initialSession.id)
            session = response.session
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func requestTakeoverToggle() {
        guard !isApplyingTakeover else { return }
        takeoverIntent = session.takeover ? .disable : .enable
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
        guard canSend, session.takeover, let api = appState.api, let token = appState.accessToken() else { return }
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

    private func interruptSession() async {
        guard !isInterrupting, let api = appState.api, let token = appState.accessToken() else { return }
        isInterrupting = true
        do {
            _ = try await api.interruptSession(token: token, sessionId: initialSession.id)
            errorMessage = nil
        } catch {
            isInterrupting = false
            errorMessage = error.localizedDescription
        }
    }

    private func resolveApproval(_ approval: Approval, status: ApprovalResolveStatus) async {
        guard resolvingApprovalId == nil, let api = appState.api, let token = appState.accessToken() else { return }
        resolvingApprovalId = approval.id
        resolvingApprovalStatus = status
        defer {
            resolvingApprovalId = nil
            resolvingApprovalStatus = nil
        }

        do {
            _ = try await api.resolveApproval(token: token, approvalId: approval.id, status: status)
            approvals.removeAll { $0.id == approval.id }
            errorMessage = nil
            await loadState(replace: false)
        } catch {
            errorMessage = error.localizedDescription
        }
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

private enum TakeoverIntent {
    case enable
    case disable
}

private enum ChatEntry: Identifiable {
    case message(TimelineItem)
    case tool(TimelineItem, Approval?)
    case artifact(TimelineItem)
    case system(TimelineItem)
    case approval(Approval)
    case notice(String, String)

    var id: String {
        switch self {
        case let .message(item):
            return item.id
        case let .tool(item, _):
            return item.id
        case let .artifact(item):
            return item.id
        case let .system(item):
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
        case let .tool(item, _):
            return item.orderSeq
        case let .artifact(item):
            return item.orderSeq
        case let .system(item):
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
    let api: APIClient?
    let token: String?
    let resolvingApprovalId: String?
    let resolvingApprovalStatus: ApprovalResolveStatus?
    let onResolveApproval: (Approval, ApprovalResolveStatus) -> Void

    var body: some View {
        switch entry {
        case let .message(item):
            MessageBubble(item: item, api: api, token: token)
        case let .tool(item, approval):
            ToolCard(
                item: item,
                approval: approval,
                resolvingApprovalId: resolvingApprovalId,
                resolvingApprovalStatus: resolvingApprovalStatus,
                onResolveApproval: onResolveApproval,
            )
        case let .artifact(item):
            ArtifactCard(item: item)
        case let .system(item):
            SystemCard(item: item)
        case let .approval(approval):
            ApprovalSummary(
                approval: approval,
                resolvingApprovalId: resolvingApprovalId,
                resolvingApprovalStatus: resolvingApprovalStatus,
                onResolveApproval: onResolveApproval,
            )
        case let .notice(kind, text):
            NoticeRow(kind: kind, text: text)
        }
    }
}

private struct ToolCard: View {
    let item: TimelineItem
    let approval: Approval?
    let resolvingApprovalId: String?
    let resolvingApprovalStatus: ApprovalResolveStatus?
    let onResolveApproval: (Approval, ApprovalResolveStatus) -> Void

    var body: some View {
        switch item.kind {
        case "command":
            CommandToolCard(
                item: item,
                approval: approval,
                resolvingApprovalId: resolvingApprovalId,
                resolvingApprovalStatus: resolvingApprovalStatus,
                onResolveApproval: onResolveApproval,
            )
        case "file_change":
            EditToolCard(
                item: item,
                approval: approval,
                resolvingApprovalId: resolvingApprovalId,
                resolvingApprovalStatus: resolvingApprovalStatus,
                onResolveApproval: onResolveApproval,
            )
        case "mcp":
            McpToolCard(
                item: item,
                approval: approval,
                resolvingApprovalId: resolvingApprovalId,
                resolvingApprovalStatus: resolvingApprovalStatus,
                onResolveApproval: onResolveApproval,
            )
        case "web_search":
            CompactToolCard(
                icon: "globe",
                badge: "Search",
                title: item.webSearchTitle,
                status: item.status,
                approval: approval,
                resolvingApprovalId: resolvingApprovalId,
                resolvingApprovalStatus: resolvingApprovalStatus,
                onResolveApproval: onResolveApproval,
            )
        default:
            CompactToolCard(
                icon: "wrench.and.screwdriver",
                badge: item.kind == "generic" ? "Tool" : item.kind.capitalized,
                title: item.shortTitle,
                status: item.status,
                approval: approval,
                resolvingApprovalId: resolvingApprovalId,
                resolvingApprovalStatus: resolvingApprovalStatus,
                onResolveApproval: onResolveApproval,
            )
        }
    }
}

private struct CompactToolCard: View {
    let icon: String
    let badge: String
    let title: String
    let status: String
    var approval: Approval? = nil
    var resolvingApprovalId: String? = nil
    var resolvingApprovalStatus: ApprovalResolveStatus? = nil
    var onResolveApproval: ((Approval, ApprovalResolveStatus) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.caption.weight(.semibold))
                    .frame(width: 24, height: 24)
                    .background {
                        Circle()
                            .fill(.secondary.opacity(0.12))
                    }
                Text(badge)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(title)
                    .font(.subheadline)
                    .lineLimit(1)
                Spacer(minLength: 8)
                StatusPill(status: status)
            }
            ApprovalFooter(
                approval: approval,
                resolvingApprovalId: resolvingApprovalId,
                resolvingApprovalStatus: resolvingApprovalStatus,
                onResolveApproval: onResolveApproval,
            )
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.secondary.opacity(0.08))
        }
    }
}

private struct CommandToolCard: View {
    let item: TimelineItem
    let approval: Approval?
    let resolvingApprovalId: String?
    let resolvingApprovalStatus: ApprovalResolveStatus?
    let onResolveApproval: (Approval, ApprovalResolveStatus) -> Void

    @State private var isExpanded: Bool

    init(
        item: TimelineItem,
        approval: Approval?,
        resolvingApprovalId: String?,
        resolvingApprovalStatus: ApprovalResolveStatus?,
        onResolveApproval: @escaping (Approval, ApprovalResolveStatus) -> Void,
    ) {
        self.item = item
        self.approval = approval
        self.resolvingApprovalId = resolvingApprovalId
        self.resolvingApprovalStatus = resolvingApprovalStatus
        self.onResolveApproval = onResolveApproval
        _isExpanded = State(initialValue: approval != nil)
    }

    private var command: String { item.commandText ?? "command" }
    private var description: String { item.content["description"]?.stringValue ?? command }
    private var output: String {
        item.content["outputPreview"]?.stringValue
            ?? item.content["outputText"]?.stringValue
            ?? ""
    }

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 10) {
                CodePanel(label: "command", code: command, leadingText: "$")
                if !output.isEmpty {
                    CodePanel(label: "output", code: output)
                }
                ApprovalFooter(
                    approval: approval,
                    resolvingApprovalId: resolvingApprovalId,
                    resolvingApprovalStatus: resolvingApprovalStatus,
                    onResolveApproval: onResolveApproval,
                )
            }
            .padding(.top, 10)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "terminal")
                Text("Ran")
                    .foregroundStyle(.secondary)
                Text(description)
                    .fontWeight(.semibold)
                    .lineLimit(1)
                Spacer(minLength: 8)
                StatusPill(status: item.status)
            }
        }
        .padding(12)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(toolBackground)
        }
        .onChange(of: approval?.id) { _, id in
            if id != nil {
                isExpanded = true
            }
        }
    }

    private var toolBackground: Color {
        item.isError ? Color.red.opacity(0.10) : Color.secondary.opacity(0.08)
    }
}

private struct EditToolCard: View {
    let item: TimelineItem
    let approval: Approval?
    let resolvingApprovalId: String?
    let resolvingApprovalStatus: ApprovalResolveStatus?
    let onResolveApproval: (Approval, ApprovalResolveStatus) -> Void

    @State private var isExpanded: Bool

    init(
        item: TimelineItem,
        approval: Approval?,
        resolvingApprovalId: String?,
        resolvingApprovalStatus: ApprovalResolveStatus?,
        onResolveApproval: @escaping (Approval, ApprovalResolveStatus) -> Void,
    ) {
        self.item = item
        self.approval = approval
        self.resolvingApprovalId = resolvingApprovalId
        self.resolvingApprovalStatus = resolvingApprovalStatus
        self.onResolveApproval = onResolveApproval
        _isExpanded = State(initialValue: approval != nil)
    }

    private var changes: [[String: JSONValue]] { item.changeObjects }
    private var filename: String {
        guard let path = changes.first?["path"]?.stringValue else { return "files" }
        return URL(fileURLWithPath: path).lastPathComponent
    }
    private var headVerb: String {
        let verbs = changes.map(fileChangeVerb)
        return verbs.first(where: { $0 == "Added" })
            ?? verbs.first(where: { $0 == "Deleted" })
            ?? verbs.first
            ?? "Edited"
    }

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(changes.enumerated()), id: \.offset) { _, change in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 8) {
                            Text(fileChangeVerb(change))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Text(change["path"]?.stringValue ?? "unknown path")
                                .font(.caption)
                                .lineLimit(1)
                        }
                        if let diff = change["diff"]?.stringValue, !diff.isEmpty {
                            DiffPanel(diff: diff, added: fileChangeVerb(change) == "Added")
                        }
                    }
                }
                ApprovalFooter(
                    approval: approval,
                    resolvingApprovalId: resolvingApprovalId,
                    resolvingApprovalStatus: resolvingApprovalStatus,
                    onResolveApproval: onResolveApproval,
                )
            }
            .padding(.top, 10)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "doc.text")
                Text(headVerb)
                    .foregroundStyle(.secondary)
                Text(filename)
                    .fontWeight(.semibold)
                    .lineLimit(1)
                Spacer(minLength: 8)
                StatusPill(status: item.status)
            }
        }
        .padding(12)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.secondary.opacity(0.08))
        }
        .onChange(of: approval?.id) { _, id in
            if id != nil {
                isExpanded = true
            }
        }
    }

    private func fileChangeVerb(_ change: [String: JSONValue]) -> String {
        guard case let .object(kind)? = change["kind"] else { return "Changed" }
        let type = kind["type"]?.stringValue
        if type == "add" { return "Added" }
        if type == "delete" { return "Deleted" }
        if type == "update" {
            return kind["move_path"]?.stringValue == nil ? "Edited" : "Renamed"
        }
        return "Changed"
    }
}

private struct McpToolCard: View {
    let item: TimelineItem
    let approval: Approval?
    let resolvingApprovalId: String?
    let resolvingApprovalStatus: ApprovalResolveStatus?
    let onResolveApproval: (Approval, ApprovalResolveStatus) -> Void

    @State private var isExpanded: Bool

    init(
        item: TimelineItem,
        approval: Approval?,
        resolvingApprovalId: String?,
        resolvingApprovalStatus: ApprovalResolveStatus?,
        onResolveApproval: @escaping (Approval, ApprovalResolveStatus) -> Void,
    ) {
        self.item = item
        self.approval = approval
        self.resolvingApprovalId = resolvingApprovalId
        self.resolvingApprovalStatus = resolvingApprovalStatus
        self.onResolveApproval = onResolveApproval
        _isExpanded = State(initialValue: approval != nil)
    }

    private var server: String { item.content["server"]?.stringValue ?? "mcp" }
    private var tool: String { item.content["tool"]?.stringValue ?? "tool" }
    private var argumentsText: String? { item.content["arguments"]?.prettyPrinted }
    private var resultText: String? {
        item.content["result"]?.prettyPrinted
            ?? item.content["outputText"]?.stringValue
            ?? item.content["text"]?.stringValue
    }

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 10) {
                if let argumentsText, !argumentsText.isEmpty {
                    CodePanel(label: "arguments", code: argumentsText)
                }
                if let resultText, !resultText.isEmpty {
                    CodePanel(label: item.isError ? "error" : "result", code: resultText)
                }
                ApprovalFooter(
                    approval: approval,
                    resolvingApprovalId: resolvingApprovalId,
                    resolvingApprovalStatus: resolvingApprovalStatus,
                    onResolveApproval: onResolveApproval,
                )
            }
            .padding(.top, 10)
        } label: {
            HStack(spacing: 8) {
                Text("MCP")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(server)
                    .fontWeight(.semibold)
                Text("·")
                    .foregroundStyle(.tertiary)
                Text(tool)
                    .lineLimit(1)
                Spacer(minLength: 8)
                StatusPill(status: item.status)
            }
        }
        .padding(12)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(item.isError ? Color.red.opacity(0.10) : Color.secondary.opacity(0.08))
        }
        .onChange(of: approval?.id) { _, id in
            if id != nil {
                isExpanded = true
            }
        }
    }
}

private struct ArtifactCard: View {
    let item: TimelineItem

    var body: some View {
        CompactToolCard(
            icon: "shippingbox",
            badge: item.kind.isEmpty ? "Artifact" : item.kind.capitalized,
            title: item.displayText ?? item.status,
            status: item.status,
        )
    }
}

private struct SystemCard: View {
    let item: TimelineItem

    var body: some View {
        if item.kind == "reasoning" {
            VStack(alignment: .leading, spacing: 8) {
                Label("Reasoning", systemImage: "sparkles")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(item.reasoningText.isEmpty ? "Reasoning" : item.reasoningText)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 6)
        } else if item.kind == "error" || item.status == "failed" {
            NoticeRow(kind: "Error", text: item.displayText ?? "Runtime error")
        } else {
            NoticeRow(kind: item.kind.capitalized, text: item.displayText ?? item.kind)
        }
    }
}

private struct StatusPill: View {
    let status: String

    var body: some View {
        Text(label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background {
                Capsule(style: .continuous)
                    .fill(fill)
            }
            .foregroundStyle(foreground)
    }

    private var label: String {
        switch status {
        case "waiting_approval":
            return "Waiting"
        default:
            return status.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    private var fill: Color {
        switch status {
        case "running", "pending", "waiting_approval":
            return Color.blue.opacity(0.16)
        case "failed", "interrupted":
            return Color.red.opacity(0.16)
        default:
            return Color.secondary.opacity(0.12)
        }
    }

    private var foreground: Color {
        switch status {
        case "running", "pending", "waiting_approval":
            return .blue
        case "failed", "interrupted":
            return .red
        default:
            return .secondary
        }
    }
}

private struct MessageBubble: View {
    let item: TimelineItem
    let api: APIClient?
    let token: String?

    @State private var isExpanded = false

    private var isUser: Bool { return item.role == "user" }
    private var text: String { return item.displayText ?? "" }
    private var attachments: [UploadedAttachment] { return item.attachments }

    var body: some View {
        HStack(alignment: .bottom) {
            if isUser { Spacer(minLength: 48) }

            VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
                if !attachments.isEmpty {
                    AttachmentPreviewGrid(attachments: attachments, api: api, token: token)
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
        Markdown(text)
            .markdownTheme(.basic)
            .markdownTextStyle(\.code) {
                FontFamilyVariant(.monospaced)
                FontSize(.em(0.94))
            }
            .markdownBlockStyle(\.codeBlock) { configuration in
                ScrollView(.horizontal, showsIndicators: false) {
                    configuration.label
                        .fixedSize(horizontal: false, vertical: true)
                        .markdownTextStyle {
                            FontFamilyVariant(.monospaced)
                            FontSize(.em(0.86))
                        }
                        .padding(12)
                }
                .background(MarkdownCodeBlockBackground())
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MarkdownCodeBlockBackground: View {
    private let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)

    var body: some View {
        if #available(iOS 26.0, *) {
            shape
                .fill(.clear)
                .glassEffect(.regular, in: shape)
        } else {
            shape
                .fill(.regularMaterial)
        }
    }
}

private struct CodePanel: View {
    let label: String
    let code: String
    var leadingText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 8) {
                    if let leadingText {
                        Text(leadingText)
                            .foregroundStyle(.secondary)
                    }
                    Text(code)
                        .textSelection(.enabled)
                }
                .font(.system(.caption, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(.secondary.opacity(0.10))
        }
    }
}

private struct DiffPanel: View {
    let diff: String
    let added: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                Text(line.isEmpty ? " " : line)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(lineForeground(line))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 2)
                    .background(lineBackground(line))
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(.secondary.opacity(0.10), lineWidth: 1)
        }
    }

    private var lines: [String] {
        diff
            .trimmingCharacters(in: CharacterSet(charactersIn: "\n"))
            .components(separatedBy: .newlines)
            .filter { !$0.hasPrefix("--- ") && !$0.hasPrefix("+++ ") && !$0.hasPrefix("diff --git") && !$0.hasPrefix("index ") }
    }

    private func lineBackground(_ line: String) -> Color {
        if added || line.hasPrefix("+") { return Color.green.opacity(0.14) }
        if line.hasPrefix("-") { return Color.red.opacity(0.14) }
        if line.hasPrefix("@@") { return Color.blue.opacity(0.12) }
        return Color.secondary.opacity(0.06)
    }

    private func lineForeground(_ line: String) -> Color {
        if added || line.hasPrefix("+") { return .green }
        if line.hasPrefix("-") { return .red }
        if line.hasPrefix("@@") { return .blue }
        return .primary
    }
}

private struct AttachmentPreviewGrid: View {
    let attachments: [UploadedAttachment]
    let api: APIClient?
    let token: String?

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            ForEach(attachments) { attachment in
                if attachment.isImage {
                    RemoteAttachmentImage(attachment: attachment, api: api, token: token)
                } else {
                    AttachmentFileCard(attachment: attachment, api: api, token: token)
                }
            }
        }
    }
}

private struct RemoteAttachmentImage: View {
    let attachment: UploadedAttachment
    let api: APIClient?
    let token: String?

    @State private var image: UIImage?
    @State private var isLoading = false

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(.secondary.opacity(0.12))
                    .overlay {
                        if isLoading {
                            ProgressView()
                        } else {
                            Image(systemName: "photo")
                                .foregroundStyle(.secondary)
                        }
                    }
            }
        }
        .frame(width: 220, height: 160)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .task(id: attachment.fileId) {
            await load()
        }
    }

    private func load() async {
        guard image == nil, !isLoading, let api, let token else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let data = try await AttachmentDataCache.shared.data(for: attachment, api: api, token: token)
            image = UIImage(data: data)
        } catch {
            image = nil
        }
    }
}

private struct AttachmentFileCard: View {
    let attachment: UploadedAttachment
    let api: APIClient?
    let token: String?

    @State private var isDownloading = false

    var body: some View {
        Button {
            Task { await downloadIfNeeded() }
        } label: {
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(.secondary.opacity(0.14))
                    .frame(width: 38, height: 38)
                    .overlay {
                        Image(systemName: attachment.fileIcon)
                            .font(.headline)
                            .foregroundStyle(.secondary)
                    }

                VStack(alignment: .leading, spacing: 3) {
                    Text(attachment.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text(attachment.detailText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)

                if isDownloading {
                    ProgressView()
                        .scaleEffect(0.72)
                } else {
                    Image(systemName: "arrow.down.circle")
                        .foregroundStyle(.secondary)
                }
            }
            .padding(10)
            .frame(width: 260)
            .background {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(.secondary.opacity(0.10))
            }
        }
        .buttonStyle(.plain)
    }

    private func downloadIfNeeded() async {
        guard !isDownloading, let api, let token else { return }
        isDownloading = true
        defer { isDownloading = false }
        _ = try? await AttachmentDataCache.shared.data(for: attachment, api: api, token: token)
    }
}

private struct ApprovalSummary: View {
    let approval: Approval
    let resolvingApprovalId: String?
    let resolvingApprovalStatus: ApprovalResolveStatus?
    let onResolveApproval: (Approval, ApprovalResolveStatus) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Approval Required", systemImage: "checkmark.shield")
                .font(.subheadline.weight(.semibold))
            Text(approval.title)
                .font(.headline)
            if let description = approval.description, !description.isEmpty {
                Text(description)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            ApprovalButtons(
                approval: approval,
                resolvingApprovalId: resolvingApprovalId,
                resolvingApprovalStatus: resolvingApprovalStatus,
                onResolveApproval: onResolveApproval,
            )
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.orange.opacity(0.14))
        }
    }
}

private struct ApprovalFooter: View {
    let approval: Approval?
    let resolvingApprovalId: String?
    let resolvingApprovalStatus: ApprovalResolveStatus?
    let onResolveApproval: ((Approval, ApprovalResolveStatus) -> Void)?

    var body: some View {
        if let approval, let onResolveApproval {
            VStack(alignment: .leading, spacing: 8) {
                Divider()
                Label(approval.title, systemImage: "hand.raised")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                if let description = approval.description, !description.isEmpty {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ApprovalButtons(
                    approval: approval,
                    resolvingApprovalId: resolvingApprovalId,
                    resolvingApprovalStatus: resolvingApprovalStatus,
                    onResolveApproval: onResolveApproval,
                )
            }
        }
    }
}

private struct ApprovalButtons: View {
    let approval: Approval
    let resolvingApprovalId: String?
    let resolvingApprovalStatus: ApprovalResolveStatus?
    let onResolveApproval: (Approval, ApprovalResolveStatus) -> Void

    private var isResolving: Bool {
        resolvingApprovalId == approval.id
    }

    private var isDisabled: Bool {
        resolvingApprovalId != nil
    }

    var body: some View {
        if approval.status != "pending" {
            Label(approval.status.replacingOccurrences(of: "_", with: " "), systemImage: "checkmark")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else {
            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    AppGlassButton(
                        "Deny",
                        role: .destructive,
                        isLoading: isResolving && resolvingApprovalStatus == .rejected,
                        disabled: isDisabled,
                    ) {
                        onResolveApproval(approval, .rejected)
                    }
                    AppGlassButton(
                        "Always Allow",
                        isLoading: isResolving && resolvingApprovalStatus == .approvedForSession,
                        disabled: isDisabled,
                    ) {
                        onResolveApproval(approval, .approvedForSession)
                    }
                }
                AppGlassButton(
                    "Allow Once",
                    style: .prominent,
                    isLoading: isResolving && resolvingApprovalStatus == .approved,
                    disabled: isDisabled,
                ) {
                    onResolveApproval(approval, .approved)
                }
            }
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
            HStack(spacing: 10) {
                ForEach(uploads, id: \.id) { upload in
                    ZStack(alignment: .topTrailing) {
                        PendingAttachmentCard(upload: upload)

                        Button {
                            onRemove(upload)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.title3)
                                .symbolRenderingMode(.hierarchical)
                                .foregroundStyle(.secondary)
                                .background {
                                    Circle()
                                        .fill(.background)
                                }
                        }
                        .buttonStyle(.plain)
                        .offset(x: 6, y: -6)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .padding(.bottom, 2)
        }
    }
}

private struct PendingAttachmentCard: View {
    let upload: AttachmentUpload

    var body: some View {
        if upload.isImage, let image = UIImage(data: upload.data) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: 86, height: 86)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(alignment: .bottomLeading) {
                    Text(upload.name)
                        .font(.caption2.weight(.semibold))
                        .lineLimit(1)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 5)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.black.opacity(0.42))
                }
        } else {
            HStack(spacing: 9) {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(.secondary.opacity(0.14))
                    .frame(width: 36, height: 36)
                    .overlay {
                        Image(systemName: upload.fileIcon)
                            .foregroundStyle(.secondary)
                    }

                VStack(alignment: .leading, spacing: 2) {
                    Text(upload.name)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text(upload.detailText)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(10)
            .frame(width: 210, height: 64, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(.regularMaterial)
            }
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
    var isBusy = false
    var hasPendingAttachments = false
    var canSendMessage = false
    var onSend: () -> Void
    var onInterrupt: () -> Void = {}
    var onPlus: () -> Void = {}
    var onCamera: () -> Void = {}
    var onRuntime: () -> Void = {}
    var isTakeoverEnabled = false
    var isTakeoverDisabled = false
    var onToggleTakeover: () -> Void = {}

    @FocusState private var isFocused: Bool

    private let composerHeight: CGFloat = 50
    private let composerCornerRadius: CGFloat = 25
    private let restingGap: CGFloat = 8
    private let glassInteractionSpacing: CGFloat = 4

    private var canSend: Bool {
        return hasComposedContent && canSendMessage && !isBusy
    }

    private var hasComposedContent: Bool {
        return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hasPendingAttachments
    }

    private var canSubmit: Bool {
        return canSend && !isSending
    }

    private var showInterrupt: Bool {
        isBusy && !hasComposedContent
    }

    var body: some View {
        Group {
            if #available(iOS 26.0, *) {
                GlassEffectContainer(spacing: glassInteractionSpacing) {
                    composerRow
                }
            } else {
                composerRow
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 2)
        .animation(.smooth(duration: 0.22), value: canSubmit)
        .animation(.smooth(duration: 0.22), value: showInterrupt)
    }

    private var composerRow: some View {
        HStack(alignment: .bottom, spacing: restingGap) {
            plusGlassButton
                .zIndex(2)

            inputGlassField
                .zIndex(1)
        }
    }

    private var plusGlassButton: some View {
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
                .font(.system(size: 18, weight: .semibold))
                .frame(width: composerHeight, height: composerHeight)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .composerGlassEffect(shape: Circle())
        .accessibilityLabel("More Content")
    }

    private var inputGlassField: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(inputPlaceholder, text: $text, axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.plain)
                .frame(minHeight: 34, alignment: .center)
                .focused($isFocused)
                .submitLabel(.send)
                .onSubmit {
                    if canSubmit {
                        onSend()
                    }
                }

            if showInterrupt {
                interruptButton
            } else if isSending {
                ProgressView()
                    .scaleEffect(0.78)
                    .frame(width: 34, height: 34)
            } else {
                sendButton
            }
        }
        .padding(.leading, 17)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
        .frame(minHeight: composerHeight)
        .composerGlassEffect(shape: RoundedRectangle(cornerRadius: composerCornerRadius, style: .continuous))
    }

    private var sendButton: some View {
        Button {
            if canSubmit {
                onSend()
            }
        } label: {
            Image(systemName: "arrow.up")
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(sendIconColor)
                .frame(width: 34, height: 34)
                .background {
                    Circle()
                        .fill(sendBackgroundColor)
                }
        }
        .buttonStyle(.plain)
        .disabled(!canSubmit)
        .accessibilityLabel("Send")
    }

    private var interruptButton: some View {
        Button {
            onInterrupt()
        } label: {
            Image(systemName: "stop.fill")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(Color.white)
                .frame(width: 34, height: 34)
                .background {
                    Circle()
                        .fill(Color.red)
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Interrupt")
    }

    private var sendBackgroundColor: Color {
        canSend ? Color.primary : Color.secondary.opacity(0.18)
    }

    private var sendIconColor: Color {
        canSend ? Color(.systemBackground) : Color.secondary
    }

    private var inputPlaceholder: String {
        if !isTakeoverEnabled {
            return "Enable Takeover to send message"
        }
        if isBusy {
            return "Send an interrupt or wait"
        }
        return "Message to agent"
    }

    private var takeoverBinding: Binding<Bool> {
        Binding(
            get: { isTakeoverEnabled },
            set: { newValue in
                if newValue != isTakeoverEnabled {
                    onToggleTakeover()
                }
            },
        )
    }
}

private extension View {
    @ViewBuilder
    func composerGlassEffect<S: Shape>(shape: S) -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(.regular.interactive(), in: shape)
        } else {
            self.background {
                shape.fill(.regularMaterial)
            }
        }
    }
}

private actor AttachmentDataCache {
    static let shared = AttachmentDataCache()

    private var memory: [String: Data] = [:]

    func data(for attachment: UploadedAttachment, api: APIClient, token: String) async throws -> Data {
        let key = cacheKey(for: attachment)
        if let data = memory[key] {
            return data
        }
        if let data = try? Data(contentsOf: fileURL(for: key)) {
            memory[key] = data
            return data
        }
        let data = try await api.downloadAttachment(token: token, sessionId: attachment.sessionId, attachment: attachment)
        memory[key] = data
        try? data.write(to: fileURL(for: key), options: [.atomic])
        return data
    }

    private func cacheKey(for attachment: UploadedAttachment) -> String {
        "\(attachment.sessionId)-\(attachment.fileId)"
    }

    private func fileURL(for key: String) -> URL {
        let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("AttachmentCache", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root.appendingPathComponent(key.safeCacheFilename)
    }
}

private extension UploadedAttachment {
    var isImage: Bool {
        mediaType.hasPrefix("image/")
    }

    var fileIcon: String {
        if mediaType.hasPrefix("text/") { return "doc.text" }
        if mediaType == "application/pdf" { return "doc.richtext" }
        if mediaType.hasPrefix("video/") { return "film" }
        if mediaType.hasPrefix("audio/") { return "waveform" }
        return "doc"
    }

    var detailText: String {
        let type = mediaType.isEmpty ? "File" : mediaType
        return "\(type) · \(size.formattedByteCount)"
    }
}

private extension AttachmentUpload {
    var isImage: Bool {
        mediaType.hasPrefix("image/")
    }

    var fileIcon: String {
        if mediaType.hasPrefix("text/") { return "doc.text" }
        if mediaType == "application/pdf" { return "doc.richtext" }
        if mediaType.hasPrefix("video/") { return "film" }
        if mediaType.hasPrefix("audio/") { return "waveform" }
        return "doc"
    }

    var detailText: String {
        let type = mediaType.isEmpty ? "File" : mediaType
        return "\(type) · \(data.count.formattedByteCount)"
    }
}

private extension Int {
    var formattedByteCount: String {
        ByteCountFormatter.string(fromByteCount: Int64(self), countStyle: .file)
    }
}

private extension String {
    var safeCacheFilename: String {
        components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .joined(separator: "-")
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
            return "Waiting"
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
    var kind: String {
        content["kind"]?.stringValue ?? ""
    }

    var displayText: String? {
        content["text"]?.stringValue
            ?? content["rawText"]?.stringValue
            ?? content["message"]?.stringValue
            ?? content["summary"]?.stringValue
    }

    var commandText: String? {
        switch content["command"] {
        case let .string(value):
            return value
        case let .array(values):
            return values.compactMap(\.stringValue).joined(separator: " ")
        default:
            return nil
        }
    }

    var shortTitle: String {
        if let tool = content["tool"]?.stringValue { return tool }
        if let commandText { return commandText.truncatedMiddle(maxLength: 50) }
        if let displayText { return displayText.truncatedMiddle(maxLength: 50) }
        return kind.isEmpty ? "tool" : kind
    }

    var webSearchTitle: String {
        if let query = content["query"]?.stringValue, !query.isEmpty {
            return query
        }
        if case let .object(action)? = content["action"],
           let url = action["url"]?.stringValue,
           !url.isEmpty
        {
            return url
        }
        return "Searched web"
    }

    var isError: Bool {
        status == "failed" || status == "interrupted" || content["error"]?.stringValue != nil
    }

    var changeObjects: [[String: JSONValue]] {
        guard case let .array(values) = content["changes"] else { return [] }
        return values.compactMap { value in
            guard case let .object(object) = value else { return nil }
            return object
        }
    }

    var reasoningText: String {
        if case let .array(values) = content["summaries"] {
            let summaries = values.compactMap { value -> String? in
                guard case let .object(object) = value else { return nil }
                return object["text"]?.stringValue
            }
            if !summaries.isEmpty {
                return summaries.joined(separator: "\n\n")
            }
        }
        return content["rawText"]?.stringValue ?? content["text"]?.stringValue ?? ""
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
                openUrl: object["openUrl"]?.stringValue,
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
                        "downloadUrl": attachment.downloadUrl.map(JSONValue.string) ?? .null,
                        "openUrl": attachment.openUrl.map(JSONValue.string) ?? .null,
                        "platformOpenUrl": attachment.platformOpenUrl.map(JSONValue.string) ?? .null,
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

    var prettyPrinted: String? {
        guard let data = try? JSONEncoder().encode(self) else { return stringValue }
        if let object = try? JSONSerialization.jsonObject(with: data),
           let pretty = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
           let string = String(data: pretty, encoding: .utf8)
        {
            return string
        }
        return String(data: data, encoding: .utf8)
    }
}

private extension String {
    func truncatedMiddle(maxLength: Int) -> String {
        guard count > maxLength, maxLength > 8 else { return self }
        let head = prefix(maxLength - 4)
        return "\(head)..."
    }
}
