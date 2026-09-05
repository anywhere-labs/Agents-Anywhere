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
    var placeholder = "询问 Agents"
    var isLoadingSettings = false
    var settingsError: String?
    var sessionChat: SessionChatModel?
    let onSend: (String) async -> Void
    var onStop: () async -> Void = {}
    var onLoadSettings: () async -> Void = {}
    var onApplySettings: () async -> Bool = { true }
    var applyError: () -> String? = { nil }

    @State private var editor = ComposerEditorController()
    @State private var showsOptions = false
    @State private var pendingPicker: AttachmentPicker?
    @State private var picker: AttachmentPicker?
    @State private var photos: [PhotosPickerItem] = []
    @State private var attachmentError: String?
    @State private var isSending = false
    @State private var importCount = 0

    private enum AttachmentPicker { case photos, files }

    var body: some View {
        ChatComposer(draft: draft, editor: editor, isStreaming: isStreaming,
            canSend: canSend, canStop: canStop, isBusy: isBusy || isSending || importCount > 0,
            placeholder: placeholder,
            maximumEditorHeight: maximumEditorHeight, controls: controls,
            onSend: send, onStop: { Task { await onStop() } },
            onOptions: { showsOptions = true })
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
        .alert("无法添加附件", isPresented: Binding(get: { attachmentError != nil }, set: { if !$0 { attachmentError = nil } })) {
            Button("好", role: .cancel) { attachmentError = nil }
        } message: { Text(attachmentError ?? "") }
    }

    private func send() {
        guard !isSending, !isBusy, importCount == 0, canSend, !isStreaming else { return }
        isSending = true
        Task { @MainActor in
            defer { isSending = false }
            guard let text = await editor.committedTextForSend() else { return }
            await onSend(text)
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

    private func append(name: String, data: Data, mediaType: String) {
        guard draft.isValid else { return }
        guard draft.attachments.count < 5 else { attachmentError = "每条消息最多添加 5 个附件。"; return }
        guard !data.isEmpty else { attachmentError = "文件为空。"; return }
        guard data.count <= 25 * 1024 * 1024 else { attachmentError = "单个附件请控制在 25 MiB 以内。"; return }
        draft.attachments.append(ChatAttachment(name: name, data: data, mediaType: mediaType))
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
                    append(name: "Photo-\(UUID().uuidString.prefix(8)).\(type.preferredFilenameExtension ?? "jpg")",
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
                        append(name: file.name, data: file.data, mediaType: file.mediaType)
                    } catch { attachmentError = error.localizedDescription }
                }
                if urls.count > 5 { attachmentError = "每条消息最多添加 5 个附件。" }
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
