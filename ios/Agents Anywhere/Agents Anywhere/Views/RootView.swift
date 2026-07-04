import SwiftUI

struct RootView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.colorScheme) private var colorScheme
    @State private var showingEnterServer = false
    @State private var showingQRCodeLogin = false
    @State private var showingSignOut = false

    var body: some View {
        Group {
            switch appState.route {
            case .loading:
                ProgressView()
                    .controlSize(.large)
            case .signedOut:
                ServiceEntryView(
                    onEnterServer: { showingEnterServer = true },
                    onQRCodeLogin: { showingQRCodeLogin = true },
                )
            case .signedIn:
                DashboardView {
                    showingSignOut = true
                }
            }
        }
        .sheet(isPresented: $showingEnterServer) {
            EnterServerView {
                appState.activateSignedInRoute()
                showingEnterServer = false
            }
        }
        .sheet(isPresented: $showingQRCodeLogin) {
            QRCodeLoginView {
                appState.activateSignedInRoute()
                showingQRCodeLogin = false
            }
        }
        .fullScreenCover(isPresented: $showingSignOut) {
            SignOutSheet {
                appState.showSignedOutRoute()
                showingSignOut = false
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
