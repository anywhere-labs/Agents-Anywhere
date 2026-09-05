import SwiftUI
import UIKit

struct EnterServerView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var path: [ServerLoginRoute] = []
    @State private var isClosing = false

    var onDashboardRequested: () -> Void = {}

    var body: some View {
        NavigationStack(path: $path) {
            ServerAddressView(
                onCancel: { dismiss() },
                onSignedIn: {
                    path.append(.success)
                },
            )
            .navigationDestination(for: ServerLoginRoute.self) { route in
                switch route {
                case .success:
                    AuthResultView(
                        title: "Login Success",
                        message: "Your iPhone is signed in. Go to your dashboard to continue.",
                        buttonTitle: "Go to Dashboard",
                        buttonSystemImage: "arrow.right",
                        symbolName: "checkmark.circle.fill",
                        symbolColor: .green,
                        isLoading: isClosing,
                    ) {
                        guard !isClosing else { return }
                        isClosing = true
                        onDashboardRequested()
                    }
                    .navigationBarBackButtonHidden(true)
                }
            }
        }
    }
}

private enum ServerLoginRoute: Hashable {
    case success
}

private struct ServerAddressView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var oauthLogin = OAuthLoginCoordinator()

    let onCancel: () -> Void
    let onSignedIn: () -> Void

    @State private var serverText = ""
    @State private var isChecking = false
    @State private var isSigningIn = false
    @State private var alertMessage: String?
    @State private var loginRequest: UUID?
    @State private var statusMessage: String?
    @State private var alertTitle = "Sign In Failed"

    var body: some View {
        AuthScreen(
            title: "Enter Server",
            subtitle: "Enter your server address, then sign in with the server's web login.",
            onCancel: onCancel,
        ) {
            VStack(alignment: .leading, spacing: 16) {
                UnderlinedTextField(
                    placeholder: "https://your-server.example.com",
                    text: $serverText,
                    keyboardType: .URL,
                    textContentType: .URL,
                    submitLabel: .continue,
                    onSubmit: {
                        guard canContinue else { return }
                        loginRequest = UUID()
                    },
                )

                AuthPrimaryButton(
                    title: "Continue in Browser",
                    isLoading: isChecking || isSigningIn,
                    disabled: !canContinue,
                ) {
                    loginRequest = UUID()
                }

                if isChecking || isSigningIn {
                    Button("Cancel Sign In") { loginRequest = nil; oauthLogin.cancel() }
                        .font(.subheadline)
                }
                if let statusMessage { Text(statusMessage).font(.footnote).foregroundStyle(.secondary) }
                Text("The server login opens in a secure web session. You can use password login or any OAuth provider configured on that server.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .task(id: loginRequest) {
            if loginRequest != nil { await startWebSignIn() }
        }
        .onDisappear { oauthLogin.cancel() }
        .alert(alertTitle, isPresented: Binding(
            get: { alertMessage != nil },
            set: { if !$0 { alertMessage = nil } },
        )) {
            if appState.authNeedsLocalNetworkSettings {
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
            }
            Button("OK", role: .cancel) {}
        } message: {
            Text(alertMessage ?? "The server could not be reached.")
        }
    }

    private var canContinue: Bool {
        !isChecking && !isSigningIn && !serverText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func startWebSignIn() async {
        guard !isChecking && !isSigningIn else { return }
        isChecking = true; statusMessage = nil; alertMessage = nil
        defer { isChecking = false; isSigningIn = false }
        guard let url = await appState.checkServer(serverText) else {
            guard !Task.isCancelled else { return }
            alertTitle = appState.authNeedsLocalNetworkSettings ? "Local Network Access" : "Server Unavailable"
            alertMessage = appState.authError ?? "The server could not be reached."
            return
        }
        guard !Task.isCancelled else { return }
        isChecking = false; isSigningIn = true
        do {
            let token = try await oauthLogin.authenticate(serverURL: url)
            try Task.checkCancellation()
            await appState.completeOAuthLogin(serverURL: url, token: token, showSignedInRoute: false)
            try Task.checkCancellation()
            if appState.authError == nil, appState.me != nil { onSignedIn() }
            else { alertTitle = "Sign In Failed"; alertMessage = appState.authError ?? "The login could not be completed." }
        } catch is CancellationError { }
        catch OAuthLoginError.cancelled { statusMessage = OAuthLoginError.cancelled.localizedDescription }
        catch {
            guard !Task.isCancelled else { return }
            alertTitle = "Sign In Failed"; alertMessage = error.localizedDescription
        }
    }
}

#Preview {
    EnterServerView()
        .environmentObject(AppState())
}

private struct UnderlinedTextField: View {
    let placeholder: String
    @Binding var text: String
    var keyboardType: UIKeyboardType = .default
    var textContentType: UITextContentType? = nil
    var submitLabel: SubmitLabel = .done
    var onSubmit: () -> Void = {}

    var body: some View {
        TextField(placeholder, text: $text)
            .textInputAutocapitalization(.never)
            .keyboardType(keyboardType)
            .autocorrectionDisabled()
            .textContentType(textContentType)
            .submitLabel(submitLabel)
            .onSubmit(onSubmit)
            .font(.title3)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .bottom) {
                Divider()
            }
    }
}

private struct UnderlinedSecureField: View {
    let placeholder: String
    @Binding var text: String

    var body: some View {
        SecureField(placeholder, text: $text)
            .textContentType(.password)
            .font(.title3)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .bottom) {
                Divider()
            }
    }
}
