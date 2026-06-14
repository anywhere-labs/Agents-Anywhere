import SwiftUI
import UIKit

struct EnterServerView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var path: [EnterServerRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            ServerAddressView(
                onCancel: { dismiss() },
                onServerReady: { url in
                    path.append(.credentials(url))
                },
            )
            .navigationDestination(for: EnterServerRoute.self) { route in
                switch route {
                case let .credentials(url):
                    PasswordLoginView(
                        serverURL: url,
                        onCancel: { dismiss() },
                        onVerified: { auth in
                            path.append(.confirmPasswordLogin(url, auth))
                        },
                    )
                case let .confirmPasswordLogin(url, auth):
                    PasswordLoginConfirmView(
                        serverURL: url,
                        auth: auth,
                        onCancel: { dismiss() },
                    )
                }
            }
        }
    }
}

private enum EnterServerRoute: Hashable {
    case credentials(URL)
    case confirmPasswordLogin(URL, AuthResponse)
}

private struct ServerAddressView: View {
    @EnvironmentObject private var appState: AppState

    let onCancel: () -> Void
    let onServerReady: (URL) -> Void

    @State private var serverText = ""
    @State private var isChecking = false
    @State private var alertMessage: String?

    var body: some View {
        AuthScreen(
            title: "Enter Server",
            subtitle: "Enter the server address you want to connect to.",
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
                        Task { await checkServer() }
                    },
                )

                AuthPrimaryButton(
                    title: "Continue",
                    isLoading: isChecking,
                    disabled: !canContinue,
                ) {
                    Task { await checkServer() }
                }

                Text("We will check that the server is available before asking for your account credentials.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
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
        !isChecking && !serverText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func checkServer() async {
        isChecking = true
        defer { isChecking = false }
        if let url = await appState.checkServer(serverText) {
            onServerReady(url)
        } else {
            alertMessage = appState.authError ?? "The server could not be reached."
        }
    }
}

private struct PasswordLoginView: View {
    @EnvironmentObject private var appState: AppState

    let serverURL: URL
    let onCancel: () -> Void
    let onVerified: (AuthResponse) -> Void

    @State private var userId = ""
    @State private var password = ""
    @State private var isSigningIn = false
    @State private var alertMessage: String?

    var body: some View {
        AuthScreen(
            title: "Sign In",
            subtitle: "Use your Agents Anywhere account for this server.",
            onCancel: onCancel,
        ) {
            VStack(alignment: .leading, spacing: 18) {
                VStack(spacing: 14) {
                    UnderlinedTextField(
                        placeholder: "User ID",
                        text: $userId,
                        textContentType: .username,
                    )

                    UnderlinedSecureField(
                        placeholder: "Password",
                        text: $password,
                    )
                }

                Text(serverURL.absoluteString)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)

                AuthPrimaryButton(
                    title: "Sign In",
                    isLoading: isSigningIn,
                    disabled: !canSignIn,
                ) {
                    Task { await signIn() }
                }
            }
        }
        .alert("Sign In Failed", isPresented: Binding(
            get: { alertMessage != nil },
            set: { if !$0 { alertMessage = nil } },
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(alertMessage ?? "Check your credentials and try again.")
        }
    }

    private var canSignIn: Bool {
        !isSigningIn
            && !userId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !password.isEmpty
    }

    private func signIn() async {
        isSigningIn = true
        defer { isSigningIn = false }
        if let auth = await appState.verifyPasswordLogin(
            serverURL: serverURL,
            userId: userId.trimmingCharacters(in: .whitespacesAndNewlines),
            password: password,
        ) {
            onVerified(auth)
        } else {
            alertMessage = appState.authError ?? "Check your credentials and try again."
        }
    }
}

private struct PasswordLoginConfirmView: View {
    @EnvironmentObject private var appState: AppState

    let serverURL: URL
    let auth: AuthResponse
    let onCancel: () -> Void

    @State private var isFinishing = false
    @State private var alertMessage: String?

    var body: some View {
        AuthScreen(
            title: "Login Success",
            subtitle: "Password verified for \(auth.userId). Go to your dashboard to continue.",
            onCancel: onCancel,
        ) {
            VStack(alignment: .leading, spacing: 22) {
                LoginSummaryView(
                    server: serverURL.absoluteString,
                    userId: auth.userId,
                )

                AuthPrimaryButton(
                    title: "Go to Dashboard",
                    isLoading: isFinishing,
                ) {
                    Task { await finishLogin() }
                }
            }
        }
        .alert("Login Failed", isPresented: Binding(
            get: { alertMessage != nil },
            set: { if !$0 { alertMessage = nil } },
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(alertMessage ?? "The login could not be completed.")
        }
        .navigationBarBackButtonHidden(true)
    }

    private func finishLogin() async {
        isFinishing = true
        defer { isFinishing = false }
        await appState.completePasswordLogin(serverURL: serverURL, auth: auth)
        if case .signedIn = appState.route {
            onCancel()
        } else {
            alertMessage = appState.authError ?? "The login could not be completed."
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
