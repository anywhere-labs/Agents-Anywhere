import SwiftUI

struct DashboardView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.colorScheme) private var colorScheme
    @State private var mode: DashboardMode = .main
    @SceneStorage("dashboard.selectedTab") private var selectedTab = DashboardTab.sessions.rawValue

    var body: some View {
        Group {
            switch mode {
            case .main:
                mainTabs
            case .composing:
                ComposeSessionView {
                    withAnimation(.snappy) {
                        mode = .main
                    }
                }
            }
        }
        .tint(AppTheme.primaryText(colorScheme))
        .task {
            await appState.refreshDashboard()
        }
    }

    private var waitingApprovalCount: Int {
        appState.sessions.filter { $0.status == "waiting_approval" }.count
    }

    private var mainTabs: some View {
        TabView(selection: $selectedTab) {
            Tab("Sessions", systemImage: "text.bubble", value: DashboardTab.sessions.rawValue) {
                SessionsTabView()
            }
            .badge(waitingApprovalCount)

            Tab("Devices", systemImage: "desktopcomputer", value: DashboardTab.devices.rawValue) {
                DevicesTabView()
            }

            Tab("Me", systemImage: "person.crop.circle", value: DashboardTab.me.rawValue) {
                MeTabView()
            }
        }
        .tabViewBottomAccessory {
            NewSessionAccessoryButton {
                withAnimation(.snappy) {
                    mode = .composing
                }
            }
        }
    }
}

private enum DashboardMode {
    case main
    case composing
}

private enum DashboardTab: String {
    case sessions
    case devices
    case me
}

private struct SessionsTabView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.colorScheme) private var colorScheme

    @State private var searchText = ""
    @State private var selectedFilter: SessionFilter?

    private var filteredSessions: [SessionSummary] {
        appState.sessions.filter { session in
            let matchesSearch = searchText.isEmpty
                || session.displayTitle.localizedCaseInsensitiveContains(searchText)
                || session.runtime.localizedCaseInsensitiveContains(searchText)
                || session.connectorId.localizedCaseInsensitiveContains(searchText)
                || (session.cwd?.localizedCaseInsensitiveContains(searchText) ?? false)
            guard matchesSearch else { return false }
            guard let selectedFilter else { return true }
            return selectedFilter.matches(session)
        }
    }

    private var pinnedSessions: [SessionSummary] {
        filteredSessions.filter(\.pinned)
    }

    private var recentSessions: [SessionSummary] {
        filteredSessions.filter { !$0.pinned }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                content
            }
            .background(AppTheme.appBackground(colorScheme))
            .navigationTitle("Sessions")
            .searchable(text: $searchText, prompt: "Search sessions")
            .safeAreaInset(edge: .top) {
                FilterBar(selectedFilter: $selectedFilter)
            }
            .refreshable {
                await appState.refreshDashboard()
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if filteredSessions.isEmpty {
            DashboardEmptyState(
                systemImage: searchText.isEmpty ? "text.bubble" : "magnifyingglass",
                title: searchText.isEmpty ? "No Sessions" : "No Matches",
                message: searchText.isEmpty
                    ? "Start a session from the web console, then monitor it here."
                    : "Try a different title, runtime, workspace, or device.",
            )
        } else {
            List {
                if !pinnedSessions.isEmpty {
                    Section("Pinned") {
                        ForEach(pinnedSessions) { session in
                            SessionListRow(session: session)
                        }
                    }
                }

                Section(pinnedSessions.isEmpty ? "Sessions" : "Recent") {
                    ForEach(recentSessions) { session in
                        SessionListRow(session: session)
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .contentMargins(.bottom, 36, for: .scrollContent)
        }
    }
}

private struct FilterBar: View {
    @Binding var selectedFilter: SessionFilter?
    @State private var activeSheet: FilterKind?

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    filterButton(.agent)
                    filterButton(.device)
                    filterButton(.workspace)
                    filterButton(.status)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.bar)
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
            .frame(minHeight: 28)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.capsule)
        .controlSize(.regular)
    }

    private func label(for kind: FilterKind) -> String {
        if selectedFilter?.kind == kind, let value = selectedFilter?.value {
            return value
        }
        return kind.defaultLabel
    }
}

private struct FilterSheet: View {
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

                ForEach(kind.options, id: \.self) { value in
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

private enum FilterKind: String, Identifiable {
    case agent
    case device
    case workspace
    case status

    var id: String { rawValue }

    var defaultLabel: String {
        switch self {
        case .agent:
            "All agents"
        case .device:
            "All devices"
        case .workspace:
            "All workspaces"
        case .status:
            "All status"
        }
    }

    var options: [String] {
        switch self {
        case .agent:
            ["Codex", "Claude Code"]
        case .device:
            ["online", "offline"]
        case .workspace:
            ["home", "work"]
        case .status:
            ["idle", "running", "waiting_approval", "error"]
        }
    }
}

private struct SessionFilter: Equatable {
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

private struct SessionListRow: View {
    let session: SessionSummary

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            StatusMark(status: session.status)
                .padding(.top, 5)

            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(session.displayTitle)
                        .font(.headline)
                        .lineLimit(2)
                    if session.unread {
                        Circle()
                            .fill(.blue)
                            .frame(width: 7, height: 7)
                    }
                    Spacer(minLength: 8)
                    Text(statusLabel)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(statusColor)
                }

                if let cwd = session.cwd, !cwd.isEmpty {
                    Text(cwd)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                HStack(spacing: 8) {
                    Label(session.runtime, systemImage: runtimeIcon)
                    Text(session.connectorStatus)
                    if session.takeover {
                        Text("Takeover")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 10)
    }

    private var runtimeIcon: String {
        session.runtime.localizedCaseInsensitiveContains("claude") ? "sparkles" : "terminal"
    }

    private var statusLabel: String {
        switch session.status {
        case "running":
            "Running"
        case "waiting_approval":
            "Approval"
        case "error":
            "Error"
        case "idle":
            "Idle"
        default:
            session.status
        }
    }

    private var statusColor: Color {
        switch session.status {
        case "running":
            .green
        case "waiting_approval":
            .orange
        case "error":
            .red
        default:
            .secondary
        }
    }
}

private struct StatusMark: View {
    let status: String

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 10, height: 10)
    }

    private var color: Color {
        switch status {
        case "running":
            .green
        case "waiting_approval":
            .orange
        case "error":
            .red
        default:
            .secondary.opacity(0.55)
        }
    }
}

private struct NewSessionAccessoryButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label("New Session", systemImage: "square.and.pencil")
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
        }
        .buttonStyle(.glassProminent)
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
    }
}

private struct DevicesTabView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        NavigationStack {
            Group {
                if appState.connectors.isEmpty {
                    DashboardEmptyState(
                        systemImage: "desktopcomputer",
                        title: "No Devices",
                        message: "Pair a connector from the web console to see it here.",
                    )
                } else {
                    List(appState.connectors) { connector in
                        DeviceRow(connector: connector)
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                }
            }
            .background(AppTheme.appBackground(colorScheme))
            .navigationTitle("Devices")
            .refreshable {
                await appState.refreshDashboard()
            }
        }
    }
}

private struct DeviceRow: View {
    let connector: ConnectorSummary

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "desktopcomputer")
                .font(.title3)
                .frame(width: 34, height: 34)

            VStack(alignment: .leading, spacing: 5) {
                Text(connector.name)
                    .font(.headline)
                Text(connector.id)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            Text(connector.status.capitalized)
                .font(.caption.weight(.semibold))
                .foregroundStyle(connector.status == "online" ? .green : .secondary)
        }
        .padding(.vertical, 10)
    }
}

private struct MeTabView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        NavigationStack {
            Form {
                Section("Account") {
                    LabeledContent("User", value: appState.me?.userId ?? "")
                    LabeledContent("Role", value: appState.me?.role.rawValue.capitalized ?? "")
                }

                Section("Server") {
                    Text(appState.serverURL?.absoluteString ?? "")
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }

                Section {
                    Button("Sign Out", role: .destructive) {
                        appState.signOut()
                    }
                }
            }
            .navigationTitle("Me")
        }
    }
}

private struct ComposeSessionView: View {
    let onCancel: () -> Void

    @State private var messageText = ""

    var body: some View {
        NavigationStack {
            List {
                Section("Runtime") {
                    Label("Choose a connected device and agent runtime", systemImage: "desktopcomputer")
                        .foregroundStyle(.secondary)
                }

                Section("Context") {
                    Text("Use the message field below to draft the first instruction for a new session. Device, workspace, and runtime selection can connect to the full create-session API next.")
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("New Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
            }
            .safeAreaInset(edge: .bottom) {
                SessionMessageInputBar(text: $messageText)
            }
        }
    }
}

private struct SessionMessageInputBar: View {
    @Binding var text: String

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Button {
            } label: {
                Image(systemName: "plus")
                    .font(.title3)
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(.borderless)

            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message", text: $text, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.plain)

                Button {
                    send()
                } label: {
                    Image(systemName: canSend ? "arrow.up.circle.fill" : "mic.fill")
                        .font(.title2)
                }
                .buttonStyle(.plain)
            }
            .padding(.leading, 14)
            .padding(.trailing, 8)
            .padding(.vertical, 7)
            .background {
                Capsule(style: .continuous)
                    .fill(.regularMaterial)
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .background(.bar)
    }

    private func send() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        text = ""
    }
}

private struct DashboardEmptyState: View {
    let systemImage: String
    let title: String
    let message: String

    var body: some View {
        ContentUnavailableView(
            title,
            systemImage: systemImage,
            description: Text(message),
        )
    }
}

private extension SessionSummary {
    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        return cwd ?? id
    }
}

#Preview {
    DashboardView()
        .environmentObject(AppState())
}
