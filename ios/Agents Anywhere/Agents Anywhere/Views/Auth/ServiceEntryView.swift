import SwiftUI

struct ServiceEntryView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.colorScheme) private var colorScheme
    @State private var showingEnterServer = false
    @State private var showingQRCodeLogin = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 28) {
                Spacer()

                VStack(spacing: 14) {
                    Image(colorScheme == .dark ? "login-logo-dark-mode" : "login-logo-light-mode")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 84, height: 84)
                        .accessibilityHidden(true)
                    VStack(spacing: 6) {
                        Text("Agents Anywhere")
                            .font(.largeTitle.weight(.bold))
                            .foregroundStyle(AppTheme.primaryText(colorScheme))
                        Text("Connect this iPhone to your self-hosted workspace.")
                            .font(.subheadline)
                            .foregroundStyle(AppTheme.secondaryText(colorScheme))
                            .multilineTextAlignment(.center)
                    }
                }

                VStack(spacing: 12) {
                    AuthPrimaryButton(title: "Enter Server", disabled: false) {
                        showingEnterServer = true
                    }

                    Button {
                        showingQRCodeLogin = true
                    } label: {
                        Label("QR Code Login", systemImage: "qrcode.viewfinder")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                }
                .frame(maxWidth: 360)

                if let error = appState.authError {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 360)
                }

                Spacer()
            }
            .padding(28)
            .background(AppTheme.appBackground(colorScheme))
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
