import SwiftUI
import UIKit

/// Compact-width session list. Rows reuse the sidebar's session row (rename,
/// pin, archive, status indicator) so both forms behave identically.
struct CompactSessionListView: View {
    let appState: AppState
    let selectedSessionId: V2SessionID?
    let onOpenSession: (V2SessionID) -> Void
    let onRenameSession: (V2SessionID, String) -> Void
    let onToggleSessionPinned: (V2SessionID, Bool) -> Void
    let onArchiveSession: (V2SessionID) -> Void

    private var sessions: [ChatSidebarSession] {
        appState.sessions
            .filter { !$0.archived }
            .map { ChatSidebarSession(session: $0) }
            .sorted { $0.presentation.precedes($1.presentation, id: $0.id, otherID: $1.id) }
    }

    private var isLoading: Bool {
        appState.isDashboardLoading && !appState.hasLoadedSessions
    }

    var body: some View {
        // Map and sort once per body, not once per section.
        let sessions = sessions
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 4) {
                if isLoading {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text(String(localized: "Loading sessions..."))
                    }
                    .font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10).frame(minHeight: 44)
                } else if sessions.isEmpty {
                    Text(String(localized: "No sessions yet"))
                        .font(.caption).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 10).frame(minHeight: 44)
                } else {
                    let pinned = sessions.filter(\.pinned)
                    let recent = sessions.filter { !$0.pinned }
                    if !pinned.isEmpty {
                        sectionLabel(String(localized: "Pinned"))
                        ForEach(pinned) { session in
                            row(session)
                        }
                    }
                    sectionLabel(String(localized: "Recent"))
                    ForEach(recent) { session in
                        row(session)
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .refreshable { await appState.refreshDashboard() }
        .scrollIndicators(.hidden)
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        .background(Color(.systemBackground))
    }

    private func sectionLabel(_ title: String) -> some View {
        Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.top, 12)
            .padding(.bottom, 6)
    }

    private func row(_ session: ChatSidebarSession) -> some View {
        ChatSidebarSessionRow(
            session: session,
            isSelected: selectedSessionId == session.id,
            onOpen: { onOpenSession(session.id) },
            onRename: { onRenameSession(session.id, $0) },
            onTogglePinned: { onToggleSessionPinned(session.id, !session.pinned) },
            onArchive: { onArchiveSession(session.id) },
            onCopyId: { UIPasteboard.general.string = session.id }
        )
    }
}
