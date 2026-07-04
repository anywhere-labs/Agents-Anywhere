import SwiftUI

struct ServiceEntryView: View {
    @EnvironmentObject private var appState: AppState
    @State private var showingEnterServer = false
    @State private var showingQRCodeLogin = false
    @State private var pendingSignedInRoute = false

    var body: some View {
        NavigationStack {
            AuthWelcomeLayout {
                AuthBrandLockup()

                VStack(spacing: 12) {
                    AuthPrimaryButton(title: "Enter Server", systemImage: "link") {
                        showingEnterServer = true
                    }

                    AuthGlassButton("QR Code Login", systemImage: "qrcode.viewfinder") {
                        showingQRCodeLogin = true
                    }
                }
                .frame(maxWidth: 340)

                if let error = appState.authError {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 340)
                }
            }
            .navigationTitle("")
            .sheet(isPresented: $showingEnterServer, onDismiss: activateSignedInRouteIfNeeded) {
                EnterServerView {
                    pendingSignedInRoute = true
                    showingEnterServer = false
                }
            }
            .sheet(isPresented: $showingQRCodeLogin, onDismiss: activateSignedInRouteIfNeeded) {
                QRCodeLoginView {
                    pendingSignedInRoute = true
                    showingQRCodeLogin = false
                }
            }
        }
    }

    private func activateSignedInRouteIfNeeded() {
        guard pendingSignedInRoute else { return }
        pendingSignedInRoute = false
        Task { await appState.showSignedInRoute() }
    }
}

#Preview {
    ServiceEntryView()
        .environmentObject(AppState())
}
