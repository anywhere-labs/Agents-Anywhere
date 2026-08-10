import SwiftUI
import UIKit

struct DeviceWorkspaceSection: View {
    let workspaces: [V2DeviceWorkspace]
    let onNewSession: (String?) -> Void

    @State private var showsAllWorkspaces = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Workspaces")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)

                Spacer()

                Button {
                    onNewSession(nil)
                } label: {
                    Image(systemName: "plus")
                        .font(.body.weight(.semibold))
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("New session")
            }

            if workspaces.isEmpty {
                Text("Workspaces appear after this device syncs sessions.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 8)
            } else {
                LazyVStack(spacing: 8) {
                    ForEach(visibleWorkspaces) { workspace in
                        DeviceWorkspaceRow(
                            workspace: workspace,
                            onOpen: { onNewSession(workspace.path) }
                        )
                    }
                }

                if workspaces.count > collapsedWorkspaceLimit {
                    Button {
                        withAnimation(.snappy) {
                            showsAllWorkspaces.toggle()
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Text(showsAllWorkspaces ? "Show fewer" : "Show all")
                            Text("\(workspaces.count)")
                                .foregroundStyle(.secondary)
                            Image(systemName: showsAllWorkspaces ? "chevron.up" : "chevron.down")
                                .font(.caption.weight(.semibold))
                        }
                    }
                    .buttonStyle(.plain)
                    .font(.subheadline.weight(.medium))
                }
            }
        }
    }

    private let collapsedWorkspaceLimit = 4

    private var visibleWorkspaces: ArraySlice<V2DeviceWorkspace> {
        workspaces.prefix(showsAllWorkspaces ? workspaces.count : collapsedWorkspaceLimit)
    }
}

private struct DeviceWorkspaceRow: View {
    let workspace: V2DeviceWorkspace
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 12) {
                Image(systemName: "folder")
                    .font(.body.weight(.medium))
                    .foregroundStyle(.secondary)

                VStack(alignment: .leading, spacing: 3) {
                    Text(workspace.name)
                        .font(.body.weight(.medium))
                        .lineLimit(1)
                    Text(workspace.sessionCount == 1 ? "1 session" : "\(workspace.sessionCount) sessions")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 8)

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
            .overlay {
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(.primary.opacity(0.08), lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("New session here", systemImage: "square.and.pencil", action: onOpen)
            Button("Copy path", systemImage: "doc.on.doc") {
                UIPasteboard.general.string = workspace.path
            }
        }
        .accessibilityHint(Text(workspace.path))
    }
}
