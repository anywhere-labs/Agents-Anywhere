import SwiftUI
import UIKit

struct DeviceSessionSection: View {
    let sessions: [V2SessionMeta]
    let filter: V2DeviceSessionFilter
    let isSelecting: Bool
    let selectedSessionIds: Set<V2SessionID>
    let isArchiveActionRunning: Bool
    let onFilterChanged: (V2DeviceSessionFilter) -> Void
    let onToggleSelecting: () -> Void
    let onSelectSession: (V2SessionID) -> Void
    let onSetSessionArchived: (V2SessionMeta, Bool) -> Void
    let onArchiveSelected: () -> Void
    let onArchiveAll: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Sessions")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)

                Spacer()

                Button(isSelecting ? "Done" : "Select", action: onToggleSelecting)
                    .buttonStyle(.plain)
                    .font(.subheadline.weight(.medium))
            }

            Picker("Session filter", selection: filterBinding) {
                ForEach(V2DeviceSessionFilter.allCases) { option in
                    Text(option.title).tag(option)
                }
            }
            .pickerStyle(.segmented)

            if isSelecting {
                DeviceSessionSelectionBar(
                    selectedCount: selectedSessionIds.count,
                    restoresSessions: filter == .archived,
                    isWorking: isArchiveActionRunning,
                    onArchive: onArchiveSelected
                )
            }

            if sessions.isEmpty {
                ContentUnavailableView(
                    emptyTitle,
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text(emptyDescription)
                )
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            } else {
                LazyVStack(spacing: 0) {
                    ForEach(sessions) { session in
                        DeviceSessionRow(
                            session: session,
                            isSelecting: isSelecting,
                            isSelected: selectedSessionIds.contains(session.id),
                            onOpen: { onSelectSession(session.id) },
                            onToggleArchived: { onSetSessionArchived(session, !session.archived) }
                        )

                        if session.id != sessions.last?.id {
                            Divider().padding(.leading, isSelecting ? 42 : 18)
                        }
                    }
                }
            }

            Button(action: onArchiveAll) {
                if isArchiveActionRunning {
                    ProgressView().controlSize(.small)
                } else {
                    Label(archiveAllTitle, systemImage: filter == .archived ? "tray.and.arrow.up" : "archivebox")
                }
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .disabled(sessions.isEmpty || isArchiveActionRunning)
        }
    }

    private var filterBinding: Binding<V2DeviceSessionFilter> {
        Binding(get: { filter }, set: onFilterChanged)
    }

    private var archiveAllTitle: LocalizedStringResource {
        filter == .archived ? "Restore all shown" : "Archive all shown"
    }

    private var emptyTitle: LocalizedStringResource {
        switch filter {
        case .active: "No active sessions"
        case .archived: "No archived sessions"
        case .all: "No sessions"
        }
    }

    private var emptyDescription: LocalizedStringResource {
        switch filter {
        case .active: "Active sessions on this device will appear here."
        case .archived: "Archived sessions on this device will appear here."
        case .all: "Sessions will appear after the Connector syncs them."
        }
    }
}

private struct DeviceSessionSelectionBar: View {
    let selectedCount: Int
    let restoresSessions: Bool
    let isWorking: Bool
    let onArchive: () -> Void

    var body: some View {
        HStack {
            Text("\(selectedCount) selected")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            Spacer()

            Button(action: onArchive) {
                if isWorking {
                    ProgressView().controlSize(.small)
                } else {
                    Label(
                        restoresSessions ? "Restore" : "Archive",
                        systemImage: restoresSessions ? "tray.and.arrow.up" : "archivebox"
                    )
                }
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .controlSize(.small)
            .disabled(selectedCount == 0 || isWorking)
        }
        .padding(.vertical, 4)
    }
}

private struct DeviceSessionRow: View {
    let session: V2SessionMeta
    let isSelecting: Bool
    let isSelected: Bool
    let onOpen: () -> Void
    let onToggleArchived: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 12) {
                if isSelecting {
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                        .font(.title3)
                } else {
                    Circle()
                        .fill(session.unread ? Color.primary : Color.secondary.opacity(0.45))
                        .frame(width: 7, height: 7)
                        .padding(.horizontal, 5)
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text(displayTitle)
                        .font(.body.weight(session.unread ? .semibold : .regular))
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    HStack(spacing: 6) {
                        Text(session.runtime)
                        Text("·")
                        Text(session.status.title)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }

                Spacer(minLength: 8)

                if let timestamp = session.sortAt ?? session.lastActivityAt ?? session.lastItemAt {
                    Text(DeviceSessionDateFormatter.display(timestamp))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Open", systemImage: "arrow.up.right", action: onOpen)
            Button(
                session.archived ? "Restore" : "Archive",
                systemImage: session.archived ? "tray.and.arrow.up" : "archivebox",
                action: onToggleArchived
            )
            Button("Copy session ID", systemImage: "doc.on.doc") {
                UIPasteboard.general.string = session.id
            }
        }
    }

    private var displayTitle: String {
        guard let title = session.title, !title.isEmpty else {
            return String(localized: "Untitled session")
        }
        return title
    }
}

private enum DeviceSessionDateFormatter {
    static func display(_ value: String) -> String {
        guard let date = try? Date(value, strategy: .iso8601) else { return value }
        if Calendar.current.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}

private extension V2RuntimeStatus {
    var title: LocalizedStringResource {
        switch self {
        case .idle: "Idle"
        case .waiting: "Waiting"
        case .waitingApproval: "Awaiting Approval"
        case .pending: "Pending"
        case .running: "Running"
        case .stopping: "Stopping"
        case .blocked: "Blocked"
        case .error: "Error"
        case .disconnected: "Disconnected"
        case .unknown: "Unknown"
        }
    }
}
