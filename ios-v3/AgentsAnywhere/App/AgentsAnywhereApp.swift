import SwiftUI

@main
struct AgentsAnywhereApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .task { await model.start() }
        }
        .onChange(of: scenePhase) { old, phase in
            if phase == .active, old != .active { model.foreground() }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.phase {
        case .launching:
            ProgressView()
        case .signedOut:
            SignInView()
        case .signedIn:
            MainView()
        }
    }
}
