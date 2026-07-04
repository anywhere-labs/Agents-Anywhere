import SwiftUI

struct ServiceEntryView: View {
    @EnvironmentObject private var appState: AppState
    var onEnterServer: () -> Void = {}
    var onQRCodeLogin: () -> Void = {}

    var body: some View {
        NavigationStack {
            AuthWelcomeLayout {
                AuthBrandLockup()

                VStack(spacing: 12) {
                    AuthPrimaryButton(title: "Enter Server", systemImage: "link") {
                        onEnterServer()
                    }

                    AuthGlassButton("QR Code Login", systemImage: "qrcode.viewfinder") {
                        onQRCodeLogin()
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
        }
    }
}

#Preview {
    ServiceEntryView()
        .environmentObject(AppState())
}
