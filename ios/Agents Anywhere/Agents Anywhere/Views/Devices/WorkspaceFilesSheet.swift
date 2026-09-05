import SwiftUI

struct WorkspaceFilesSheet: View {
    @Environment(\.dismiss) private var dismiss

    let connectorId: V2ConnectorID
    let workspace: V2DeviceWorkspace
    let service: V2WorkspaceFilesService

    var session: V2SessionModel?
    @State private var destination: FileDestination?
    @State private var transfer: FileTransferRequest?
    @State private var detent: PresentationDetent = .medium
    @State private var previewErrorMessage: String?

    private enum FileDestination: Identifiable {
        case preview(V2WorkspaceEntry), save(WorkspaceDownloadedFile), open(WorkspaceDownloadedFile)
        var id: String {
            switch self {
            case .preview(let entry): "preview:" + entry.path
            case .save(let file): "save:" + file.id.absoluteString
            case .open(let file): "open:" + file.id.absoluteString
            }
        }
    }
    private struct FileTransferRequest: Equatable {
        let id = UUID()
        let entry: V2WorkspaceEntry
        let action: WorkspaceFileAction
    }

    var body: some View {
        NavigationStack {
            WorkspaceDirectoryView(
                connectorId: connectorId,
                root: workspace.path,
                path: ".",
                title: workspace.name,
                service: service,
                onOpenFile: openFile, onFileAction: startTransfer, canRead: canRead,
                canTransfer: canRead && transfer == nil
            )
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    SheetCloseButton {
                        dismiss()
                    }
                }
            }
            .navigationDestination(for: WorkspaceDirectoryRoute.self) { route in
                WorkspaceDirectoryView(
                    connectorId: connectorId,
                    root: workspace.path,
                    path: route.path,
                    title: route.title,
                    service: service,
                    onOpenFile: openFile, onFileAction: startTransfer, canRead: canRead,
                    canTransfer: canRead && transfer == nil
                )
            }
            .safeAreaInset(edge: .bottom) {
                if let transfer {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("正在下载 \(transfer.entry.name)…").font(.footnote).lineLimit(1)
                        Spacer(minLength: 0)
                        Button("取消") { self.transfer = nil }.font(.footnote)
                    }
                    .padding(16).background(.regularMaterial)
                }
            }
        }
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationContentInteraction(.resizes).presentationDragIndicator(.visible)
        .sheet(item: $destination) { destination in
            switch destination {
            case .preview(let entry):
                WorkspaceFilePreviewSheet(connectorId: connectorId, root: workspace.path,
                    path: entry.path, service: service, session: session)
            case .save(let file): WorkspaceFileExportPicker(file: file, onFinish: finishTransfer)
            case .open(let file): WorkspaceFileActivitySheet(file: file, onFinish: finishTransfer)
            }
        }
        .task(id: transfer) {
            guard let request = transfer else { return }
            defer { if transfer?.id == request.id { transfer = nil } }
            do {
                let file = try await service.download(connectorId: connectorId, root: workspace.path, entry: request.entry)
                try Task.checkCancellation()
                guard transfer?.id == request.id, session?.isValid != false else { return }
                destination = request.action == .download ? .save(file) : .open(file)
            } catch { if !Task.isCancelled { previewErrorMessage = error.localizedDescription } }
        }
        .onDisappear { transfer = nil }
        .alert("文件操作失败", isPresented: previewErrorBinding) {
            Button("好", role: .cancel) {
                previewErrorMessage = nil
            }
        } message: {
            Text(previewErrorMessage ?? "")
        }
    }

    private var previewErrorBinding: Binding<Bool> {
        Binding(
            get: { previewErrorMessage != nil },
            set: { isPresented in
                if !isPresented { previewErrorMessage = nil }
            }
        )
    }

    private var canRead: Bool {
        guard let session else { return true }
        return session.isValid && session.network.availability != .offline && session.metadata?.connectorStatus == .online
    }
    private func openFile(_ entry: V2WorkspaceEntry) {
        guard canRead else { previewErrorMessage = "设备或网络已离线，请恢复连接后重试。"; return }
        destination = .preview(entry)
    }
    private func startTransfer(_ entry: V2WorkspaceEntry, action: WorkspaceFileAction) {
        guard canRead, entry.isFile, transfer == nil else { return }
        previewErrorMessage = nil
        transfer = FileTransferRequest(entry: entry, action: action)
    }
    private func finishTransfer(_ error: String?) {
        destination = nil
        if let error { previewErrorMessage = error }
    }
}

private enum WorkspaceFileAction: Equatable { case download, openIn }

private struct WorkspaceDirectoryRoute: Hashable {
    let path: String
    let title: String
}

private struct WorkspaceDirectoryView: View {
    let connectorId: V2ConnectorID
    let root: String
    let path: String
    let title: String
    let service: V2WorkspaceFilesService
    let onOpenFile: (V2WorkspaceEntry) -> Void
    let onFileAction: (V2WorkspaceEntry, WorkspaceFileAction) -> Void
    let canRead: Bool
    let canTransfer: Bool

    @State private var model = WorkspaceDirectoryModel()

    var body: some View {
        List {
            if !canRead {
                Label("设备或网络已离线，已加载的目录仍可查看。", systemImage: "wifi.slash")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if let error = model.errorMessage, !model.entries.isEmpty {
                Text(error).font(.footnote).foregroundStyle(.secondary)
            }
            if model.isLoading && model.entries.isEmpty {
                HStack(spacing: 12) {
                    ProgressView()
                    Text("Loading files...")
                        .foregroundStyle(.secondary)
                }
            } else if let errorMessage = model.errorMessage, model.entries.isEmpty {
                ContentUnavailableView {
                    Label("Unable to Load Files", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(errorMessage)
                } actions: {
                    Button("Retry") {
                        Task { await loadDirectory() }
                    }
                    .buttonStyle(.borderedProminent).disabled(!canRead)
                }
            } else if model.entries.isEmpty {
                ContentUnavailableView(
                    "Empty Folder",
                    systemImage: "folder",
                    description: Text("This workspace folder has no files.")
                )
            } else {
                ForEach(model.entries) { entry in
                    WorkspaceEntryRow(
                        entry: entry,
                        onOpenFile: onOpenFile,
                        canRead: canRead
                    )
                    .contextMenu {
                        Button("复制路径", systemImage: "document.on.document") { UIPasteboard.general.string = entry.path }
                        if entry.isFile {
                            Button("下载", systemImage: "arrow.down.to.line") { onFileAction(entry, .download) }
                                .disabled(!canTransfer)
                            Button("其他打开方式…", systemImage: "square.and.arrow.up") { onFileAction(entry, .openIn) }
                                .disabled(!canTransfer)
                        }
                    }
                }
            }

            if model.isTruncated {
                Label("Some files are not shown.", systemImage: "ellipsis.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await loadDirectory()
        }
        .task(id: "\(path):\(canRead)") {
            await loadDirectory()
        }
    }

    private func loadDirectory() async {
        guard canRead else { return }
        await model.load(
            connectorId: connectorId,
            root: root,
            path: path,
            service: service
        )
    }
}

private struct WorkspaceEntryRow: View {
    let entry: V2WorkspaceEntry
    let onOpenFile: (V2WorkspaceEntry) -> Void
    let canRead: Bool

    var body: some View {
        if entry.isDirectory {
            NavigationLink(value: WorkspaceDirectoryRoute(path: entry.path, title: entry.name)) {
                label
            }
        } else {
            Button {
                onOpenFile(entry)
            } label: {
                label
            }
            .disabled(!entry.isFile || !canRead)
        }
    }

    private var label: some View {
        HStack(spacing: 12) {
            Image(systemName: entry.isDirectory ? "folder" : "doc")
                .foregroundStyle(.secondary)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                if let size = entry.size, entry.isFile {
                    Text(ByteCountFormatStyle(style: .file).format(Int64(size)))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 8)

        }
        .contentShape(Rectangle())
    }
}
