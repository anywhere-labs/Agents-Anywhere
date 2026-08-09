import SwiftUI

@main
struct AgentsAnywhereApp: App {
    @StateObject private var appState = AppState()
    @AppStorage(AppAppearance.storageKey) private var appearanceValue = AppAppearance.system.rawValue

    init() {
        AppFontRegistry.registerBundledFonts()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appState)
                .preferredColorScheme(appearance.colorScheme)
        }
    }

    private var appearance: AppAppearance {
        AppAppearance(rawValue: appearanceValue) ?? .system
    }
}
