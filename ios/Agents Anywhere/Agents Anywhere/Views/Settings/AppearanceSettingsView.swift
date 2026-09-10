import SwiftUI

struct AppearanceSettingsView: View {
    @AppStorage(AppAppearance.storageKey) private var appearanceValue = AppAppearance.system.rawValue

    var body: some View {
        List {
            Section {
                ForEach(AppAppearance.allCases) { appearance in
                    Button { appearanceValue = appearance.rawValue } label: {
                        HStack(spacing: 14) {
                            AppSymbol(symbol(appearance)).frame(width: 24)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(appearance.title).foregroundStyle(.primary)
                                Text(appearance.description).font(.footnote).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if appearanceValue == appearance.rawValue { AppSymbol("checkmark") }
                        }.padding(.vertical, 6)
                    }
                    .accessibilityAddTraits(appearanceValue == appearance.rawValue ? .isSelected : [])
                }
            }
        }.settingsPage(String(localized: "Appearance"))
    }
    private func symbol(_ appearance: AppAppearance) -> String {
        switch appearance {
        case .system: "desktopcomputer"
        case .light: "sun.max"
        case .dark: "moon"
        }
    }
}
