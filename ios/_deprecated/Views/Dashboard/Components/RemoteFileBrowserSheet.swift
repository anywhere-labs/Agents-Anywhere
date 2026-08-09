import SwiftUI

enum RemoteFileBrowserMode: Hashable {
    case pickDirectory
    case pickFile
    case browse
}

struct RemoteFileSelection: Hashable {
    let path: String
    let entry: FsEntry?
}

struct RemoteFileBrowserSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    let api: APIClient
    let token: String
    let connector: ConnectorSummary
    let mode: RemoteFileBrowserMode
    let initialPath: String
    let onSelect: (RemoteFileSelection) -> Void

    @State private var currentPath: String
    @State private var entries: [FsEntry] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var selectedEntry: FsEntry?
    @State private var previewingPath: String?

    init(
        api: APIClient,
        token: String,
        connector: ConnectorSummary,
        mode: RemoteFileBrowserMode,
        initialPath: String,
        onSelect: @escaping (RemoteFileSelection) -> Void
    ) {
        self.api = api
        self.token = token
        self.connector = connector
        self.mode = mode
        self.initialPath = initialPath
        self.onSelect = onSelect
        let path = initialPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "~" : initialPath
        _currentPath = State(initialValue: path)
    }

    private var sortedEntries: [FsEntry] {
        entries.sorted { lhs, rhs in
            if lhs.isDirectory != rhs.isDirectory {
                return lhs.isDirectory
            }
            return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
    }

    private var parentPath: String? {
        let parent = RemotePath.parent(of: currentPath)
        return parent.isEmpty ? nil : parent
    }

    private var canSelectCurrentDirectory: Bool {
        mode == .pickDirectory && !currentPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canSelectEntry: Bool {
        guard let selectedEntry else { return false }
        switch mode {
        case .pickDirectory:
            return selectedEntry.isDirectory
        case .pickFile:
            return selectedEntry.isFile
        case .browse:
            return false
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(connector.name)
                        .font(.headline)
                    .padding(.vertical, 4)
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    if let parentPath {
                        Button {
                            Task { await load(path: parentPath) }
                        } label: {
                            RemoteFileRow(
                                title: "..",
                                subtitle: parentPath,
                                systemImage: "folder",
                                isSelected: false,
                            )
                        }
                    }

                    if isLoading && entries.isEmpty {
                        HStack {
                            ProgressView()
                            Text("Loading directory...")
                                .foregroundStyle(.secondary)
                        }
                    } else if sortedEntries.isEmpty {
                        ContentUnavailableView(
                            "Empty Folder",
                            systemImage: "folder",
                            description: Text("No files or folders in this path."),
                        )
                    } else {
                        ForEach(sortedEntries) { entry in
                            Button {
                                handleEntryTap(entry)
                            } label: {
                                RemoteFileRow(
                                    title: entry.name,
                                    subtitle: entrySubtitle(entry),
                                    systemImage: entry.isDirectory ? "folder" : "doc",
                                    isSelected: selectedEntry == entry,
                                )
                            }
                        }
                    }
                } header: {
                    HStack {
                        Text(currentPath)
                            .lineLimit(1)
                        Spacer()
                        if isLoading {
                            ProgressView()
                                .scaleEffect(0.75)
                        }
                    }
                }
            }
            .navigationTitle(navigationTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    SheetCloseButton {
                        dismiss()
                    }
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button("Select") {
                        selectCurrentTarget()
                    }
                    .disabled(!canSelectCurrentDirectory && !canSelectEntry)
                }
            }
            .refreshable {
                await load(path: currentPath)
            }
            .task {
                await load(path: currentPath)
            }
        }
    }

    private var navigationTitle: String {
        switch mode {
        case .pickDirectory:
            return "Choose Folder"
        case .pickFile:
            return "Choose File"
        case .browse:
            return "Files"
        }
    }

    private func handleEntryTap(_ entry: FsEntry) {
        if entry.isDirectory {
            Task { await load(path: entry.path) }
            return
        }
        if mode == .browse {
            Task { await openPreview(entry) }
            return
        }
        selectedEntry = entry
    }

    private func openPreview(_ entry: FsEntry) async {
        guard previewingPath == nil else { return }
        previewingPath = entry.path
        errorMessage = nil
        defer { previewingPath = nil }
        do {
            let response = try await api.createConnectorFsPreviewToken(
                token: token,
                connectorId: connector.id,
                root: currentPath,
                path: entry.path,
            )
            let url = try api.filePreviewURL(previewToken: response.previewToken, name: entry.name)
            openURL(url)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func selectCurrentTarget() {
        if canSelectEntry, let selectedEntry {
            onSelect(RemoteFileSelection(path: selectedEntry.path, entry: selectedEntry))
        } else {
            onSelect(RemoteFileSelection(path: currentPath, entry: nil))
        }
        dismiss()
    }

    private func load(path: String) async {
        let target = path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "~" : path
        isLoading = true
        errorMessage = nil
        do {
            let response = try await api.connectorFsList(
                token: token,
                connectorId: connector.id,
                root: target,
            )
            currentPath = response.result.path
            entries = response.result.entries
            selectedEntry = nil
        } catch {
            entries = []
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func entrySubtitle(_ entry: FsEntry) -> String {
        if entry.isDirectory {
            return "Folder"
        }
        if let size = entry.size {
            return ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)
        }
        return entry.type.capitalized
    }
}

private struct RemoteFileRow: View {
    let title: String
    let subtitle: String
    let systemImage: String
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .foregroundStyle(.secondary)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            if isSelected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.tint)
            }
        }
        .contentShape(Rectangle())
    }
}

private enum RemotePath {
    static func parent(of path: String) -> String {
        let clean = path.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\\", with: "/")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if clean.isEmpty || clean == "." || clean == "~" {
            return ""
        }
        if path == "/" {
            return ""
        }
        if clean.hasPrefix("~") {
            let remainder = clean.dropFirst()
            let parts = remainder.split(separator: "/")
            if parts.isEmpty {
                return ""
            }
            let parentParts = parts.dropLast()
            return parentParts.isEmpty ? "~" : "~/" + parentParts.joined(separator: "/")
        }
        let normalized = path.replacingOccurrences(of: "\\", with: "/")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let parts = normalized.split(separator: "/")
        if parts.count <= 1 {
            return path.hasPrefix("/") ? "/" : "."
        }
        return (path.hasPrefix("/") ? "/" : "") + parts.dropLast().joined(separator: "/")
    }
}
