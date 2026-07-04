import SwiftUI
import UIKit

struct EnterServerView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ServerAddressView(
                onCancel: { dismiss() }
            )
        }
    }
}

private struct ServerAddressView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var oauthLogin = OAuthLoginCoordinator()

    let onCancel: () -> Void

    @State private var serverText = ""
    @State private var isChecking = false
    @State private var isSigningIn = false
    @State private var didSignIn = false
    @State private var alertMessage: String?

    var body: some View {
        Group {
            if didSignIn {
                AuthResultView(
                    title: "Login Success",
                    message: "Your iPhone is signed in. Go to your dashboard to continue.",
                    buttonTitle: "Go to Dashboard",
                    buttonSystemImage: "arrow.right",
                    symbolName: "checkmark.circle.fill",
                    symbolColor: .green,
                ) {
                    Task { await finishLogin() }
                }
            } else {
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
                                Task { await startWebSignIn() }
                            },
                        )

                        AuthPrimaryButton(
                            title: "Continue in Browser",
                            isLoading: isChecking || isSigningIn,
                            disabled: !canContinue,
                        ) {
                            Task { await startWebSignIn() }
                        }

                        Text("The server login opens in a secure web session. You can use password login or any OAuth provider configured on that server.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .alert("Server Unavailable", isPresented: Binding(
            get: { alertMessage != nil },
            set: { if !$0 { alertMessage = nil } },
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(alertMessage ?? "The server could not be reached.")
        }
    }

    private var canContinue: Bool {
        !isChecking && !isSigningIn && !serverText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func startWebSignIn() async {
        isChecking = true
        guard let url = await appState.checkServer(serverText) else {
            isChecking = false
            alertMessage = appState.authError ?? "The server could not be reached."
            return
        }
        isChecking = false
        isSigningIn = true
        defer { isSigningIn = false }
        do {
            let token = try await oauthLogin.authenticate(serverURL: url)
            await appState.completeOAuthLogin(serverURL: url, token: token, showSignedInRoute: false)
            if appState.me != nil {
                didSignIn = true
            } else {
                alertMessage = appState.authError ?? "The login could not be completed."
            }
        } catch {
            alertMessage = error.localizedDescription
        }
    }

    private func finishLogin() async {
        await appState.showSignedInRoute()
        onCancel()
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
