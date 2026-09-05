import SwiftUI

@main
struct AgentsAnywhereApp: App {
    @StateObject private var appState = AppState()
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(AppAppearance.storageKey) private var appearanceValue = AppAppearance.system.rawValue

    init() {
        AppFontRegistry.registerBundledFonts()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appState)
                .preferredColorScheme(appearance.colorScheme)
                .onChange(of: scenePhase) { _, phase in
                    if phase == .background { appState.setAppInBackground(true) }
                    else if phase == .active { appState.setAppInBackground(false) }
                }
        }
    }

    private var appearance: AppAppearance {
        AppAppearance(rawValue: appearanceValue) ?? .system
    }
}
