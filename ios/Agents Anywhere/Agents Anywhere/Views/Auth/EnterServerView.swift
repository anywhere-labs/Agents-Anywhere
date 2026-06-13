import SwiftUI

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
                    )
                }
            }
        }
    }
}

private enum EnterServerRoute: Hashable {
    case credentials(URL)
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
                TextField("Server Address", text: $serverText, prompt: Text("https://your-server.example.com"))
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .textContentType(.URL)
                    .textFieldStyle(.roundedBorder)
                    .controlSize(.large)
                    .submitLabel(.continue)
                    .onSubmit {
                        guard canContinue else { return }
                        Task { await checkServer() }
                    }

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
                Form {
                    Section {
                        TextField("User ID", text: $userId)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textContentType(.username)
                        SecureField("Password", text: $password)
                            .textContentType(.password)
                    } footer: {
                        Text(serverURL.absoluteString)
                    }
                }
                .scrollContentBackground(.hidden)
                .frame(minHeight: 150)

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
        await appState.login(serverURL: serverURL, userId: userId, password: password)
        if case .signedIn = appState.route {
            onCancel()
        } else {
            alertMessage = appState.authError ?? "Check your credentials and try again."
        }
    }
}

#Preview {
    EnterServerView()
        .environmentObject(AppState())
}
