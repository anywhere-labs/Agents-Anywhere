import SwiftUI

private struct SettingsCloseKey: EnvironmentKey {
    static let defaultValue: () -> Void = {}
}
extension EnvironmentValues {
    var closeSettings: () -> Void {
        get { self[SettingsCloseKey.self] }
        set { self[SettingsCloseKey.self] = newValue }
    }
}

struct SettingsRow: View {
    let title: String
    let symbol: String
    var value: String?
    var body: some View {
        if let value, !value.isEmpty {
            LabeledContent {
                Text(value).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            } label: {
                Label(title, appSymbol: symbol)
            }
        } else {
            Label(title, appSymbol: symbol)
        }
    }
}

private struct SettingsPageChrome: ViewModifier {
    let title: String
    @Environment(\.closeSettings) private var close
    func body(content: Content) -> some View {
        content
            .listStyle(.insetGrouped)
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetCloseToolbar(action: close) }
    }
}
extension View {
    func settingsPage(_ title: String) -> some View { modifier(SettingsPageChrome(title: title)) }
}

struct SettingsLanguageView: View {
    @Environment(\.openURL) private var openURL
    var body: some View {
        List {
            Section {
                LabeledContent(String(localized: "Current language"), value: Self.currentLanguage)
                Button(String(localized: "Open iOS Settings")) {
                    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                }
            } footer: {
                Text(String(localized: "Choose English or Simplified Chinese in the app's iOS language settings. Without an override, the app follows your preferred system language."))
            }
        }.settingsPage(String(localized: "Language"))
    }
    static var currentLanguage: String {
        Bundle.main.preferredLocalizations.first?.hasPrefix("zh") == true ? "简体中文" : "English"
    }
}

struct SettingsServerView: View {
    @Environment(AppState.self) private var appState
    @State private var isAdding = false
    @State private var isReordering = false
    var body: some View {
        List {
            Section {
                ForEach(appState.serverAddresses) { address in
                    ServerAddressRow(
                        address: address,
                        isActive: address.url == appState.serverURL,
                        probe: appState.addressProbes[address.id]
                    )
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) { appState.removeServerAddress(id: address.id) } label: {
                            Text(String(localized: "Delete"))
                        }
                    }
                }
                .onMove { indices, destination in
                    appState.moveServerAddresses(from: indices, to: destination)
                }
                Button(String(localized: "Add server address"), appSymbol: "plus") { isAdding = true }
            } header: {
                Text(String(localized: "Addresses"))
            } footer: {
                Text(String(localized: "The app prefers the first reachable address and switches back automatically. Reorder to change priority; tap an address to test it once."))
            }
            if let error = appState.restoreConnectionError {
                Section { Text(error).foregroundStyle(.secondary) }
            }
        }
        .environment(\.editMode, .constant(isReordering ? EditMode.active : EditMode.inactive))
        .settingsPage(String(localized: "Server"))
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(isReordering ? String(localized: "Done") : String(localized: "Reorder")) {
                    isReordering.toggle()
                }
            }
        }
        .sheet(isPresented: $isAdding) { AddServerAddressSheet() }
    }
}

private struct ServerAddressRow: View {
    let address: ServerAddress
    let isActive: Bool
    let probe: ServerAddressProbe?
    @Environment(AppState.self) private var appState
    @State private var isProbing = false

    var body: some View {
        Button {
            guard !isProbing else { return }
            isProbing = true
            Task {
                await appState.probeServerAddress(id: address.id)
                isProbing = false
            }
        } label: {
            HStack(spacing: 10) {
                ServerAddressDot(tone: tone)
                VStack(alignment: .leading, spacing: 2) {
                    Text(address.url.absoluteString)
                        .font(.callout)
                        .multilineTextAlignment(.leading)
                    HStack(spacing: 8) {
                        if isActive {
                            Text(String(localized: "In use")).font(.caption).foregroundStyle(.tint)
                        }
                        if let probe {
                            Text(probeText(probe)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                Spacer(minLength: 4)
                if isProbing { ProgressView().controlSize(.small) }
            }
        }
        .buttonStyle(.plain)
    }

    private var tone: ServerAddressDot.Tone {
        guard let probe else { return .unknown }
        guard probe.reachable else { return .bad }
        guard let latency = probe.latencyMS else { return .ok }
        if latency < 200 { return .ok }
        if latency <= 800 { return .slow }
        return .bad
    }

    private func probeText(_ probe: ServerAddressProbe) -> String {
        guard probe.reachable else { return String(localized: "Unreachable") }
        return "\(probe.latencyMS ?? 0) ms"
    }
}

private struct ServerAddressDot: View {
    enum Tone { case ok, slow, bad, unknown }
    let tone: Tone
    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
    }
    private var color: Color {
        switch tone {
        case .ok: return .green
        case .slow: return .yellow
        case .bad: return .red
        case .unknown: return Color(.systemGray3)
        }
    }
}

struct SettingsAboutView: View {
    var body: some View {
        List {
            Section {
                LabeledContent(String(localized: "Version"), value: Self.version)
                LabeledContent(String(localized: "Build"), value: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—")
            }
            Section {
                NavigationLink {
                    ScrollView {
                        Text(license).font(.footnote.monospaced()).textSelection(.enabled).padding(22)
                    }.settingsPage(String(localized: "Open-source notices"))
                } label: { SettingsRow(title: String(localized: "Open-source notices"), symbol: "doc.text") }
            }
        }.settingsPage(String(localized: "About"))
    }
    static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—" }
    private var license: String {
        Bundle.main.url(forResource: "Lucide", withExtension: "txt").flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? "Lucide · ISC"
    }
}
