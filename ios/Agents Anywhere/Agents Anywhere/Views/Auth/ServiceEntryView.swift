import SwiftUI

struct ServiceEntryView: View {
    @EnvironmentObject private var appState: AppState
    @State private var showsPrivacyPolicy = false
    var onManualLogin: () -> Void = {}
    var onQRCodeLogin: () -> Void = {}

    var body: some View {
        NavigationStack {
            AuthWelcomeLayout {
                AuthBrandLockup()

                VStack(spacing: 12) {
                    AuthPrimaryButton(title: String(localized: "QR Code Login"), systemImage: "qrcode.viewfinder") {
                        onQRCodeLogin()
                    }

                    AuthGlassButton(String(localized: "Manual Login"), systemImage: "link") {
                        onManualLogin()
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
            .safeAreaInset(edge: .bottom) {
                Button(String(localized: "privacyPolicy.title")) { showsPrivacyPolicy = true }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(minHeight: 44)
                    .padding(.horizontal, 24)
                    .buttonStyle(.plain)
            }
        }
        .sheet(isPresented: $showsPrivacyPolicy) {
            PrivacyPolicySheet()
        }
    }
}

#Preview {
    ServiceEntryView()
        .environmentObject(AppState())
}
