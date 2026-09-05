import SwiftUI

struct WorkspaceFilesSheet: View {
    @Environment(\.dismiss) private var dismiss

    let connectorId: V2ConnectorID
    let workspace: V2DeviceWorkspace
    let service: V2WorkspaceFilesService

    var session: V2SessionModel?
    @State private var preview: V2WorkspaceEntry?
    @State private var previewErrorMessage: String?

    var body: some View {
        NavigationStack {
            WorkspaceDirectoryView(
                connectorId: connectorId,
                root: workspace.path,
                path: ".",
                title: workspace.name,
                service: service,
                onOpenFile: openFile, canRead: canRead
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
                    onOpenFile: openFile, canRead: canRead
                )
            }
        }
        .sheet(item: $preview) { preview in
            WorkspaceFilePreviewSheet(connectorId: connectorId, root: workspace.path,
                path: preview.path, service: service, session: session)
        }
        .alert("Unable to preview file", isPresented: previewErrorBinding) {
            Button("OK", role: .cancel) {
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
        preview = entry
    }
}

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
    let canRead: Bool

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
                        onOpenFile: onOpenFile
                    ).disabled(!canRead && !entry.isDirectory)
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
            .disabled(!entry.isFile)
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
