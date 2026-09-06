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
        HStack(spacing: 14) {
            AppSymbol(symbol).frame(width: 24)
            Text(title)
            Spacer(minLength: 12)
            if let value, !value.isEmpty {
                Text(value).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
        }.frame(minHeight: 32)
    }
}

private struct SettingsPageChrome: ViewModifier {
    let title: String
    @Environment(\.closeSettings) private var close
    func body(content: Content) -> some View {
        content
            .scrollContentBackground(.hidden).background(Color(uiColor: .systemBackground))
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
    @EnvironmentObject private var appState: AppState
    var body: some View {
        List {
            Section(String(localized: "Connection")) {
                LabeledContent(String(localized: "Status"), value: appState.isServerConnected ? String(localized: "Connected") : String(localized: "Offline"))
                if let url = appState.serverURL {
                    Text(url.absoluteString).font(.callout.monospaced()).textSelection(.enabled)
                    Button(String(localized: "Copy server address"), appSymbol: "doc.on.doc") {
                        UIPasteboard.general.string = url.absoluteString
                    }
                }
            }
            if let error = appState.restoreConnectionError {
                Section { Text(error).foregroundStyle(.secondary) }
            }
        }.settingsPage(String(localized: "Server"))
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
