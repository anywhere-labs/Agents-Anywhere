import SwiftUI
import WebKit

struct WorkspaceFilesSheet: View {
    @Environment(\.dismiss) private var dismiss

    let connectorId: V2ConnectorID
    let workspace: V2DeviceWorkspace
    let service: V2WorkspaceFilesService

    @State private var preview: WorkspaceWebPreview?
    @State private var previewingPath: String?
    @State private var previewErrorMessage: String?

    var body: some View {
        NavigationStack {
            WorkspaceDirectoryView(
                connectorId: connectorId,
                root: workspace.path,
                path: ".",
                title: workspace.name,
                service: service,
                previewingPath: previewingPath,
                onOpenFile: openFile
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
                    previewingPath: previewingPath,
                    onOpenFile: openFile
                )
            }
        }
        .sheet(item: $preview) { preview in
            WorkspaceWebPreviewSheet(url: preview.url)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
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

    private func openFile(_ entry: V2WorkspaceEntry) {
        guard previewingPath == nil else { return }
        previewingPath = entry.path
        Task {
            defer { previewingPath = nil }
            do {
                let url = try await service.previewURL(
                    connectorId: connectorId,
                    root: workspace.path,
                    entry: entry
                )
                preview = WorkspaceWebPreview(url: url)
            } catch {
                previewErrorMessage = error.localizedDescription
            }
        }
    }
}

private struct WorkspaceDirectoryRoute: Hashable {
    let path: String
    let title: String
}

private struct WorkspaceWebPreview: Identifiable {
    let url: URL

    var id: String { url.absoluteString }
}

private struct WorkspaceDirectoryView: View {
    let connectorId: V2ConnectorID
    let root: String
    let path: String
    let title: String
    let service: V2WorkspaceFilesService
    let previewingPath: String?
    let onOpenFile: (V2WorkspaceEntry) -> Void

    @State private var model = WorkspaceDirectoryModel()

    var body: some View {
        List {
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
                    .buttonStyle(.borderedProminent)
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
                        isPreviewing: previewingPath == entry.path,
                        onOpenFile: onOpenFile
                    )
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
        .task(id: path) {
            await loadDirectory()
        }
    }

    private func loadDirectory() async {
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
    let isPreviewing: Bool
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
            .disabled(!entry.isFile || isPreviewing)
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

            if isPreviewing {
                ProgressView()
                    .controlSize(.small)
            }
        }
        .contentShape(Rectangle())
    }
}

private struct WorkspaceWebPreviewSheet: View {
    let url: URL

    var body: some View {
        WebView(url: url)
    }
}

