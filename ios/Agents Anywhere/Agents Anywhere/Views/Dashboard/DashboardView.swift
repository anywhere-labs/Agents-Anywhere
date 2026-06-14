import SwiftUI

struct DashboardView: View {
    @EnvironmentObject private var appState: AppState
    @State private var isShowingNewSession = false

    var body: some View {
        RootTabsView {
            isShowingNewSession = true
        }
        .task {
            await appState.refreshDashboard()
        }
        .sheet(isPresented: $isShowingNewSession) {
            NewSessionSheet()
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }
}

private struct RootTabsView: View {
    let onNewSession: () -> Void

    @SceneStorage("selectedRootTab")
    private var selectedTab: String = "sessions"

    var body: some View {
        TabView(selection: $selectedTab) {
            Tab("Sessions", systemImage: "rectangle.stack.fill", value: "sessions") {
                NavigationStack {
                    SessionsView(onNewSession: onNewSession)
                }
            }

            Tab("Devices", systemImage: "desktopcomputer", value: "devices") {
                NavigationStack {
                    DevicesView()
                        .navigationTitle("Devices")
                }
            }

            Tab("Me", systemImage: "person.crop.circle.fill", value: "me") {
                NavigationStack {
                    MeView()
                        .navigationTitle("Me")
                }
            }
        }
    }
}

private struct SessionsView: View {
    @EnvironmentObject private var appState: AppState

    let onNewSession: () -> Void

    @State private var activeFilter: SessionFilter?
    @State private var selectedStatus = "All"
    @State private var selectedRuntime = "Any Runtime"
    @State private var selectedDevice = "Any Device"
    @State private var selectedSort = "Recent"

    private var filteredSessions: [SessionSummary] {
        sortedSessions.filter { session in
            let matchesStatus = selectedStatus == "All" || session.statusLabel == selectedStatus
            let matchesRuntime = selectedRuntime == "Any Runtime"
                || session.runtime.localizedCaseInsensitiveContains(selectedRuntime)
            let matchesDevice = selectedDevice == "Any Device"
                || session.connectorStatus.localizedCaseInsensitiveContains(selectedDevice)
                || session.connectorId.localizedCaseInsensitiveContains(selectedDevice)
            return matchesStatus && matchesRuntime && matchesDevice
        }
    }

    private var sortedSessions: [SessionSummary] {
        switch selectedSort {
        case "Oldest":
            appState.sessions.sorted { $0.sortKey < $1.sortKey }
        case "Name":
            appState.sessions.sorted { $0.displayTitle.localizedCaseInsensitiveCompare($1.displayTitle) == .orderedAscending }
        case "Status":
            appState.sessions.sorted { $0.status.localizedCaseInsensitiveCompare($1.status) == .orderedAscending }
        default:
            appState.sessions.sorted { $0.sortKey > $1.sortKey }
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                sessionList
            }
            .padding(.bottom, 32)
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: onNewSession) {
                    Image(systemName: "plus")
                }
            }
        }
        .refreshable {
            await appState.refreshDashboard()
        }
        .sheet(item: $activeFilter) { filter in
            FilterSheet(
                filter: filter,
                selectedStatus: $selectedStatus,
                selectedRuntime: $selectedRuntime,
                selectedDevice: $selectedDevice,
                selectedSort: $selectedSort,
            )
            .presentationDetents([.height(320), .medium])
            .presentationDragIndicator(.visible)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Sessions")
                .font(.largeTitle.weight(.bold))

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    FilterPill(
                        title: "Status",
                        value: selectedStatus,
                        systemImage: "circle.grid.2x2.fill",
                    ) {
                        activeFilter = .status
                    }

                    FilterPill(
                        title: "Runtime",
                        value: selectedRuntime,
                        systemImage: "terminal.fill",
                    ) {
                        activeFilter = .runtime
                    }

                    FilterPill(
                        title: "Device",
                        value: selectedDevice,
                        systemImage: "laptopcomputer",
                    ) {
                        activeFilter = .device
                    }

                    FilterPill(
                        title: "Sort",
                        value: selectedSort,
                        systemImage: "arrow.up.arrow.down",
                    ) {
                        activeFilter = .sort
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 4)
            }
            .padding(.horizontal, -20)
        }
        .padding(.horizontal, 20)
        .padding(.top, 24)
    }

    @ViewBuilder
    private var sessionList: some View {
        if filteredSessions.isEmpty {
            ContentUnavailableView(
                "No Sessions",
                systemImage: "rectangle.stack",
                description: Text("Start a session from the web console, then monitor it here."),
            )
            .frame(maxWidth: .infinity)
            .padding(.top, 80)
        } else {
            VStack(spacing: 12) {
                ForEach(filteredSessions) { session in
                    NavigationLink {
                        SessionDetailView(initialSession: session)
                    } label: {
                        SessionCard(session: session)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 20)
        }
    }
}

private struct DevicesView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        List {
            if appState.connectors.isEmpty {
                ContentUnavailableView(
                    "No Devices",
                    systemImage: "desktopcomputer",
                    description: Text("Pair a connector from the web console to see it here."),
                )
            } else {
                Section("Devices") {
                    ForEach(appState.connectors) { connector in
                        DeviceRow(connector: connector)
                    }
                }
            }
        }
        .refreshable {
            await appState.refreshDashboard()
        }
    }
}

private struct MeView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    Image(systemName: "person.crop.circle.fill")
                        .font(.system(size: 48))
                        .foregroundStyle(.secondary)

                    VStack(alignment: .leading, spacing: 4) {
                        Text(appState.me?.userId ?? "")
                            .font(.headline)

                        Text(appState.me?.role.rawValue.capitalized ?? "")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 8)
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
    }
}

private struct NewSessionSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var prompt = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Create a new session")
                        .font(.title.weight(.bold))

                    Text("Describe what you want the agent to do. Runtime and device selection will be added to this native flow next.")
                        .font(.body)
                        .foregroundStyle(.secondary)

                    VStack(spacing: 12) {
                        NewSessionOption(
                            title: "Start from scratch",
                            subtitle: "Create an empty agent session",
                            systemImage: "plus.square.on.square",
                        )

                        NewSessionOption(
                            title: "Use current device",
                            subtitle: "Run locally on a paired connector",
                            systemImage: "laptopcomputer.and.iphone",
                        )

                        NewSessionOption(
                            title: "Cloud runtime",
                            subtitle: "Create a hosted session",
                            systemImage: "cloud.fill",
                        )
                    }
                }
                .padding(20)
                .padding(.bottom, 90)
            }
            .navigationTitle("New")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) {
                GlassMessageInputBar(text: $prompt, showsAttachmentButton: true) {
                    prompt = ""
                    dismiss()
                }
            }
        }
    }
}

private enum SessionFilter: String, Identifiable {
    case status
    case runtime
    case device
    case sort

    var id: String { rawValue }

    var title: String {
        switch self {
        case .status:
            return "Status"
        case .runtime:
            return "Runtime"
        case .device:
            return "Device"
        case .sort:
            return "Sort"
        }
    }

    var options: [String] {
        switch self {
        case .status:
            ["All", "Running", "Idle", "Approval", "Error"]
        case .runtime:
            ["Any Runtime", "Codex", "Claude Code"]
        case .device:
            ["Any Device", "online", "offline"]
        case .sort:
            ["Recent", "Oldest", "Name", "Status"]
        }
    }
}

private struct FilterSheet: View {
    @Environment(\.dismiss) private var dismiss

    let filter: SessionFilter

    @Binding var selectedStatus: String
    @Binding var selectedRuntime: String
    @Binding var selectedDevice: String
    @Binding var selectedSort: String

    var body: some View {
        NavigationStack {
            List {
                ForEach(filter.options, id: \.self) { option in
                    Button {
                        setSelection(option)
                        dismiss()
                    } label: {
                        HStack {
                            Text(option)
                                .foregroundStyle(.primary)

                            Spacer()

                            if isSelected(option) {
                                Image(systemName: "checkmark")
                                    .fontWeight(.semibold)
                            }
                        }
                    }
                }
            }
            .navigationTitle(filter.title)
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func isSelected(_ option: String) -> Bool {
        switch filter {
        case .status:
            selectedStatus == option
        case .runtime:
            selectedRuntime == option
        case .device:
            selectedDevice == option
        case .sort:
            selectedSort == option
        }
    }

    private func setSelection(_ option: String) {
        switch filter {
        case .status:
            selectedStatus = option
        case .runtime:
            selectedRuntime = option
        case .device:
            selectedDevice = option
        case .sort:
            selectedSort = option
        }
    }
}

private struct FilterPill: View {
    let title: String
    let value: String
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: systemImage)
                Text(value)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
            }
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 13)
            .padding(.vertical, 9)
            .background {
                Capsule(style: .continuous)
                    .fill(.regularMaterial)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title): \(value)")
    }
}

private struct SessionCard: View {
    let session: SessionSummary

    var body: some View {
        HStack(spacing: 14) {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(.secondary.opacity(0.14))
                .frame(width: 54, height: 54)
                .overlay {
                    Image(systemName: symbol)
                        .font(.title3)
                        .foregroundStyle(.secondary)
                }

            VStack(alignment: .leading, spacing: 5) {
                Text(session.displayTitle)
                    .font(.headline)
                    .lineLimit(1)

                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            Text(session.statusLabel)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background {
                    Capsule(style: .continuous)
                        .fill(.secondary.opacity(0.12))
                }
        }
        .padding(14)
        .background {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(.regularMaterial)
        }
    }

    private var subtitle: String {
        let workspace = session.cwd ?? "No workspace"
        return "\(workspace) · \(session.runtime) · \(session.connectorStatus)"
    }

    private var symbol: String {
        session.runtime.localizedCaseInsensitiveContains("claude")
            ? "sparkles.rectangle.stack.fill"
            : "terminal.fill"
    }
}

private struct DeviceRow: View {
    let connector: ConnectorSummary

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 3) {
                Text(connector.name)
                statusText
            }
        } icon: {
            Image(systemName: "desktopcomputer")
        }
    }

    @ViewBuilder
    private var statusText: some View {
        if connector.status == "online" {
            Text(connector.status.capitalized)
                .font(.caption)
                .foregroundStyle(.green)
        } else {
            Text(connector.status.capitalized)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

private struct NewSessionOption: View {
    let title: String
    let subtitle: String
    let systemImage: String

    var body: some View {
        Button {
        } label: {
            HStack(spacing: 14) {
                Image(systemName: systemImage)
                    .font(.title3)
                    .frame(width: 36, height: 36)
                    .background {
                        Circle()
                            .fill(.secondary.opacity(0.14))
                    }

                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.headline)
                        .foregroundStyle(.primary)

                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.tertiary)
            }
            .padding(14)
            .background {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(.regularMaterial)
            }
        }
        .buttonStyle(.plain)
    }
}

#Preview {
    DashboardView()
        .environmentObject(AppState())
}
