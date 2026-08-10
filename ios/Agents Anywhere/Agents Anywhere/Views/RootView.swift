import SwiftUI

struct RootView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.colorScheme) private var colorScheme
    @State private var showingEnterServer = false
    @State private var showingQRCodeLogin = false

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
                ChatShellView()
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
        .sheet(isPresented: serverUnavailableBinding) {
            ServerUnavailableSheet(
                isRetrying: appState.isRetryingServerConnection,
                onReturnToLogin: appState.returnToLogin,
                onRetry: retryServerConnection,
            )
        }
        .tint(AppTheme.primaryText(colorScheme))
        .background(AppTheme.appBackground(colorScheme))
    }

    private var serverUnavailableBinding: Binding<Bool> {
        Binding(
            get: { appState.serverConnectionIssue != nil },
            set: { _ in },
        )
    }

    private func retryServerConnection() {
        Task {
            await appState.retryServerConnection()
        }
    }
}

#Preview {
    RootView()
        .environmentObject(AppState())
}
