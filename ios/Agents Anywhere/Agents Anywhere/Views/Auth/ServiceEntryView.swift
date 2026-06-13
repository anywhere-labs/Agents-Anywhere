import SwiftUI

struct ServiceEntryView: View {
    @EnvironmentObject private var appState: AppState
    @State private var showingEnterServer = false
    @State private var showingQRCodeLogin = false

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
            .sheet(isPresented: $showingEnterServer) {
                EnterServerView()
            }
            .sheet(isPresented: $showingQRCodeLogin) {
                QRCodeLoginView()
            }
        }
    }
}

#Preview {
    ServiceEntryView()
        .environmentObject(AppState())
}
