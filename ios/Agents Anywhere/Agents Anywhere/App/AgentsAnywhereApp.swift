import SwiftUI

@main
struct AgentsAnywhereApp: App {
    @StateObject private var appState = AppState()

    init() {
        AppFontRegistry.registerBundledFonts()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appState)
        }
    }
}
