import SwiftUI

struct RootView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Group {
            switch appState.route {
            case .loading:
                ProgressView()
                    .controlSize(.large)
            case .signedOut:
                ServiceEntryView()
            case .signedIn:
                DashboardView()
            }
        }
        .tint(AppTheme.primaryText(colorScheme))
        .background(AppTheme.appBackground(colorScheme))
    }
}

#Preview {
    RootView()
        .environmentObject(AppState())
}
