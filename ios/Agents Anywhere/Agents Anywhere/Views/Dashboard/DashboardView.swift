import SwiftUI

struct DashboardView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        TabView {
            SessionsListView()
                .tabItem {
                    Label("Sessions", systemImage: "text.bubble")
                }
                .badge(pendingCount)

            DevicesListView()
                .tabItem {
                    Label("Devices", systemImage: "desktopcomputer")
                }

            ApprovalsPlaceholderView()
                .tabItem {
                    Label("Approvals", systemImage: "checkmark.shield")
                }
                .badge(pendingCount)

            SettingsView()
                .tabItem {
                    Label("Settings", systemImage: "gearshape")
                }
        }
        .task {
            await appState.refreshDashboard()
        }
        .tint(AppTheme.primaryText(colorScheme))
    }

    private var pendingCount: Int {
        appState.sessions.filter { $0.status == "waiting_approval" }.count
    }
}

struct SessionsListView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.colorScheme) private var colorScheme
    @State private var searchText = ""
    @State private var selectedFilter: SessionFilter?

    var filteredSessions: [SessionSummary] {
        appState.sessions.filter { session in
            let matchesSearch = searchText.isEmpty
                || session.displayTitle.localizedCaseInsensitiveContains(searchText)
                || (session.cwd?.localizedCaseInsensitiveContains(searchText) ?? false)
                || session.runtime.localizedCaseInsensitiveContains(searchText)
            guard matchesSearch else { return false }
            guard let selectedFilter else { return true }
            return selectedFilter.matches(session)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if !pinnedSessions.isEmpty {
                    Section("Pinned") {
                        ForEach(pinnedSessions) { session in
                            SessionRow(session: session)
                        }
                    }
                }

                Section("Recents") {
                    ForEach(recentSessions) { session in
                        SessionRow(session: session)
                    }
                }
            }
            .listStyle(.plain)
            .navigationTitle("Sessions")
            .scrollContentBackground(.hidden)
            .background(AppTheme.appBackground(colorScheme))
            .searchable(text: $searchText)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                    } label: {
                        Image(systemName: "magnifyingglass")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    AccountAvatar(userId: appState.me?.userId ?? "?")
                }
            }
            .safeAreaInset(edge: .top) {
                FilterBar(selectedFilter: $selectedFilter)
                    .padding(.horizontal)
                    .padding(.bottom, 8)
                    .background(AppTheme.appBackground(colorScheme))
            }
            .refreshable {
                await appState.refreshDashboard()
            }
        }
    }

    private var pinnedSessions: [SessionSummary] {
        filteredSessions.filter(\.pinned)
    }

    private var recentSessions: [SessionSummary] {
        filteredSessions.filter { !$0.pinned }
    }
}

struct FilterBar: View {
    @Binding var selectedFilter: SessionFilter?
    @Environment(\.colorScheme) private var colorScheme
    @State private var activeSheet: FilterKind?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                filterButton(.agent)
                filterButton(.device)
                filterButton(.workspace)
                filterButton(.status)
            }
        }
        .sheet(item: $activeSheet) { kind in
            FilterSheet(kind: kind, selectedFilter: $selectedFilter)
                .presentationDetents([.medium, .large])
        }
    }

    private func filterButton(_ kind: FilterKind) -> some View {
        Button {
            activeSheet = kind
        } label: {
            HStack(spacing: 6) {
                Text(label(for: kind))
                Image(systemName: "chevron.down")
                    .font(.caption2)
            }
            .font(.subheadline)
            .foregroundStyle(AppTheme.primaryText(colorScheme))
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(AppTheme.appBackground(colorScheme), in: Capsule())
            .overlay(
                Capsule().stroke(AppTheme.secondaryControlStroke(colorScheme), lineWidth: 1),
            )
        }
        .buttonStyle(.plain)
    }

    private func label(for kind: FilterKind) -> String {
        if selectedFilter?.kind == kind, let value = selectedFilter?.value {
            return value
        }
        return kind.defaultLabel
    }
}

struct FilterSheet: View {
    let kind: FilterKind
    @Binding var selectedFilter: SessionFilter?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Button("All \(kind.defaultLabel.lowercased())") {
                    selectedFilter = nil
                    dismiss()
                }
                ForEach(kind.demoOptions, id: \.self) { value in
                    Button {
                        selectedFilter = SessionFilter(kind: kind, value: value)
                        dismiss()
                    } label: {
                        HStack {
                            Text(value)
                            Spacer()
                            if selectedFilter == SessionFilter(kind: kind, value: value) {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            }
            .navigationTitle(kind.defaultLabel)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

enum FilterKind: String, Identifiable {
    case agent
    case device
    case workspace
    case status

    var id: String { rawValue }

    var defaultLabel: String {
        switch self {
        case .agent:
            return "All agents"
        case .device:
            return "All devices"
        case .workspace:
            return "All workspaces"
        case .status:
            return "All status"
        }
    }

    var demoOptions: [String] {
        switch self {
        case .agent:
            return ["Codex", "Claude Code"]
        case .device:
            return ["Online", "Offline"]
        case .workspace:
            return ["home", "work"]
        case .status:
            return ["idle", "running", "waiting_approval", "error"]
        }
    }
}

struct SessionFilter: Equatable {
    let kind: FilterKind
    let value: String

    func matches(_ session: SessionSummary) -> Bool {
        switch kind {
        case .agent:
            session.runtime.localizedCaseInsensitiveContains(value)
        case .device:
            session.connectorStatus.localizedCaseInsensitiveContains(value)
        case .workspace:
            session.cwd?.localizedCaseInsensitiveContains(value) ?? false
        case .status:
            session.status == value
        }
    }
}

struct SessionRow: View {
    let session: SessionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Text(session.displayTitle)
                    .font(.headline)
                Spacer()
                StatusDot(status: session.status)
                Text(relativeLabel)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Text(session.cwd ?? "No workspace")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            HStack(spacing: 7) {
                Text(session.runtime)
                Text("·")
                Text(session.connectorStatus)
            }
            .font(.caption)
            .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 8)
    }

    private var relativeLabel: String {
        if session.status == "running" { return "Live" }
        if session.status == "waiting_approval" { return "Wait" }
        if session.status == "error" { return "Error" }
        return "Updated"
    }
}

private extension SessionSummary {
    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        return cwd ?? id
    }
}

struct StatusDot: View {
    let status: String

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 7, height: 7)
    }

    private var color: Color {
        switch status {
        case "running": .green
        case "waiting_approval": .orange
        case "error": .red
        default: .secondary
        }
    }
}

struct AccountAvatar: View {
    let userId: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Text(String(userId.prefix(1)).uppercased())
            .font(.headline)
            .foregroundStyle(AppTheme.primaryControlForeground(colorScheme))
            .frame(width: 36, height: 36)
            .background(AppTheme.primaryControlBackground(colorScheme), in: Circle())
    }
}

struct DevicesListView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        NavigationStack {
            List(appState.connectors) { connector in
                VStack(alignment: .leading, spacing: 6) {
                    Text(connector.name)
                        .font(.headline)
                    Text(connector.id)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(connector.status)
                        .font(.caption)
                        .foregroundStyle(connector.status == "online" ? .green : .secondary)
                }
                .padding(.vertical, 6)
            }
            .navigationTitle("Devices")
            .refreshable {
                await appState.refreshDashboard()
            }
        }
    }
}

struct ApprovalsPlaceholderView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        NavigationStack {
            List(appState.sessions.filter { $0.status == "waiting_approval" }) { session in
                SessionRow(session: session)
            }
            .navigationTitle("Approvals")
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        NavigationStack {
            Form {
                Section("Account") {
                    LabeledContent("User", value: appState.me?.userId ?? "")
                    LabeledContent("Role", value: appState.me?.role.rawValue ?? "")
                }
                Section("Server") {
                    Text(appState.serverURL?.absoluteString ?? "")
                        .foregroundStyle(.secondary)
                }
                Section {
                    Button("Sign Out", role: .destructive) {
                        appState.signOut()
                    }
                }
            }
            .navigationTitle("Settings")
        }
    }
}

#Preview {
    DashboardView()
        .environmentObject(AppState())
}
