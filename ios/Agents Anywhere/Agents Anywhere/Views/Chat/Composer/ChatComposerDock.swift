import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// Both New Session and existing sessions use the same persistent editor and
/// picker hosts. Only the commit action and capability facts differ.
struct ChatComposerDock: View {
    @Bindable var draft: ComposerDraft
    let settings: ConversationSettings
    let maximumEditorHeight: CGFloat
    let controls: ChatControlMetrics
    var canSend = true
    var canAttach = true
    var canSelectModel = true
    var canSelectPermission = true
    var isStreaming = false
    var canStop = true
    var isBusy = false
    var placeholder = String(localized: "询问 Agents")
    var isLoadingSettings = false
    var settingsError: String?
    var sessionChat: SessionChatModel?
    /// 键盘避让后的可视高度（含 dock 自身）。矮空间（横屏+键盘）下
    /// 指令列表按它扣减输入栏/标题行收缩，避免面板顶进导航栏玻璃。
    var availableHeight: CGFloat = .infinity
    let onSend: (String) async -> Void
    var onStop: () async -> Void = {}
    var onLoadSettings: () async -> Void = {}
    var onApplySettings: () async -> Bool = { true }
    var applyError: () -> String? = { nil }
    var onDraftChange: () -> Void = {}
    var queueMode = false
    var alternativeDeliveries: [V2MessageDelivery] = []
    var onSendWith: (String, V2MessageDelivery) async -> Void = { _, _ in }

    @State private var editor = ComposerEditorController()
    @State private var showsOptions = false
    @State private var pendingPicker: AttachmentPicker?
    @State private var picker: AttachmentPicker?
    @State private var photos: [PhotosPickerItem] = []
    @State private var attachmentError: String?
    @State private var isSending = false
    @State private var importCount = 0
    @State private var showsCommandMenu = false

    private enum AttachmentPicker { case photos, files }

    /// 浮层面板定位用的 dock 实际高度（不含面板）。
    @State private var dockHeight: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            ChatComposer(draft: draft, editor: editor, isStreaming: isStreaming,
                canSend: canSend, canStop: canStop, isBusy: isBusy || isSending || importCount > 0,
                placeholder: placeholder,
                maximumEditorHeight: maximumEditorHeight, controls: controls,
                onSend: send, onStop: { Task { await onStop() } },
                onOptions: { showsOptions = true },
                showsCommands: sessionChat?.offersCommands == true, commandsActive: showsCommandMenu,
                onCommands: { showsCommandMenu.toggle() },
                onDraftChange: onDraftChange,
                queueMode: queueMode, alternativeDeliveries: alternativeDeliveries,
                onSendWith: { send($0) })
        }
        // 指令面板浮在 dock 上方（不占布局高度）：占位会把 safeAreaInset 的
        // dock 撑高、压缩消息流视口——弹出即推动消息流，且面板高度参与
        // 键盘跟随的对齐计算导致末条消息"不贴合"输入框。浮层只盖住消息
        // 流底部，对齐参照恒为输入框顶。
        // 列表高度按可视高度扣减（dock 自身 + 面板标题行 + 余量），
        // 横屏+键盘时面板收缩到正好贴在导航栏下方，不顶进玻璃层。
        .overlay(alignment: .bottom) {
            if let sessionChat {
                CommandSuggestionPanel(chat: sessionChat, draft: draft, forced: $showsCommandMenu,
                    listMaxHeight: min(240, max(120, availableHeight - dockHeight - 60)))
                    .offset(y: -dockHeight)
            }
        }
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.height
        } action: { height in
            dockHeight = height
        }
        .onChange(of: sessionChat?.optionsRequest) { _, _ in showsOptions = true }
        .frame(maxWidth: ChatControlMetrics.maximumContentWidth)
        .frame(maxWidth: .infinity)
        .background {
            ZStack {
                Color.clear.photosPicker(isPresented: pickerBinding(.photos), selection: $photos,
                    maxSelectionCount: max(1, 5 - draft.attachments.count), matching: .images)
                Color.clear.fileImporter(isPresented: pickerBinding(.files), allowedContentTypes: [.item],
                    allowsMultipleSelection: true, onCompletion: importFiles)
            }
        }
        .sheet(isPresented: $showsOptions, onDismiss: presentPicker) {
            ComposerOptionsSheet(settings: settings,
                onPhotos: { queue(.photos) }, onFiles: { queue(.files) },
                canAttach: canAttach && draft.attachments.count < 5 && importCount == 0,
                canSelectModel: canSelectModel, canSelectPermission: canSelectPermission,
                isLoading: isLoadingSettings, loadingError: settingsError,
                onReload: onLoadSettings, onApply: onApplySettings, applyError: applyError, sessionChat: sessionChat)
                .task(id: "\(canSelectModel):\(canSelectPermission)") { await onLoadSettings() }
        }
        .onChange(of: photos) { _, items in importPhotos(items) }
        .onDisappear {
            editor.finishEditing()
            draft.isFocused = false
        }
        .alert(String(localized: "无法添加附件"), isPresented: Binding(get: { attachmentError != nil }, set: { if !$0 { attachmentError = nil } })) {
            Button(String(localized: "好"), role: .cancel) { attachmentError = nil }
        } message: { Text(attachmentError ?? "") }
    }

    private func send() { send(nil) }

    private func send(_ delivery: V2MessageDelivery?) {
        guard !isSending, !isBusy, importCount == 0, canSend, !isStreaming || queueMode else { return }
        isSending = true
        Task { @MainActor in
            defer { isSending = false }
            guard let text = await editor.committedTextForSend() else { return }
            if let delivery { await onSendWith(text, delivery) } else { await onSend(text) }
        }
    }

    private func queue(_ next: AttachmentPicker) { pendingPicker = next; showsOptions = false }
    private func presentPicker() {
        guard let next = pendingPicker else { return }
        pendingPicker = nil; picker = next
    }
    private func pickerBinding(_ value: AttachmentPicker) -> Binding<Bool> {
        Binding(get: { picker == value }, set: { if $0 { picker = value } else if picker == value { picker = nil } })
    }

    private func append(name: String, data: Data, mediaType: String) async {
        guard draft.isValid else { return }
        guard draft.attachments.count < 5 else { attachmentError = String(localized: "每条消息最多添加 5 个附件。"); return }
        guard !data.isEmpty else { attachmentError = String(localized: "文件为空。"); return }
        guard data.count <= 25 * 1024 * 1024 else { attachmentError = String(localized: "单个附件请控制在 25 MiB 以内。"); return }
        let preview = mediaType.hasPrefix("image/")
            ? await Task.detached(priority: .utility) { ChatImageThumbnail.make(data: data) }.value : nil
        guard draft.isValid, draft.attachments.count < 5 else { return }
        draft.attachments.append(ChatAttachment(name: name, data: data, mediaType: mediaType, previewData: preview))
    }

    private func importPhotos(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        importCount += 1
        Task { @MainActor in
            defer { importCount -= 1; photos = [] }
            for item in items {
                do {
                    guard let data = try await item.loadTransferable(type: Data.self) else { continue }
                    let type = item.supportedContentTypes.first ?? .jpeg
                    await append(name: "Photo-\(UUID().uuidString.prefix(8)).\(type.preferredFilenameExtension ?? "jpg")",
                           data: data, mediaType: type.preferredMIMEType ?? "image/jpeg")
                } catch { attachmentError = error.localizedDescription }
            }
        }
    }

    private func importFiles(_ result: Result<[URL], Error>) {
        do {
            let urls = try result.get()
            importCount += 1
            Task { @MainActor in
                defer { importCount -= 1 }
                for url in urls.prefix(5) {
                    do {
                        let file = try await Task.detached(priority: .userInitiated) { try ImportedChatFile.read(url) }.value
                        await append(name: file.name, data: file.data, mediaType: file.mediaType)
                    } catch { attachmentError = error.localizedDescription }
                }
                if urls.count > 5 { attachmentError = String(localized: "每条消息最多添加 5 个附件。") }
            }
        } catch { attachmentError = error.localizedDescription }
    }
}

nonisolated private struct ImportedChatFile: Sendable {
    let name: String
    let data: Data
    let mediaType: String

    static func read(_ url: URL) throws -> Self {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        // Bound the read even when the document provider has no file-size metadata.
        let data = try handle.read(upToCount: 25 * 1024 * 1024 + 1) ?? Data()
        let type = try url.resourceValues(forKeys: [.contentTypeKey]).contentType
        return Self(name: url.lastPathComponent, data: data, mediaType: type?.preferredMIMEType ?? "application/octet-stream")
    }
}
