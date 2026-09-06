import SwiftUI

struct AppearanceSettingsView: View {
    @AppStorage(AppAppearance.storageKey) private var appearanceValue = AppAppearance.system.rawValue

    var body: some View {
        Form {
            Section {
                Picker(String(localized: "Appearance"), selection: $appearanceValue) {
                    ForEach(AppAppearance.allCases) { appearance in
                        Text(appearance.title)
                            .tag(appearance.rawValue)
                    }
                }
                .pickerStyle(.segmented)
            } footer: {
                Text(selectedAppearance.description)
            }
        }
        .navigationTitle(String(localized: "Appearance"))
        .navigationBarTitleDisplayMode(.inline)
    }

    private var selectedAppearance: AppAppearance {
        AppAppearance(rawValue: appearanceValue) ?? .system
    }
}
