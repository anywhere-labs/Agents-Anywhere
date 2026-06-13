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
                        onBack: { _ = path.popLast() },
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
    @Environment(\.colorScheme) private var colorScheme

    let onCancel: () -> Void
    let onServerReady: (URL) -> Void

    @State private var serverText = ""

    var body: some View {
        AuthScreen(
            title: "Enter Server",
            showsBack: false,
            onBack: nil,
            onCancel: onCancel,
        ) {
            VStack(alignment: .leading, spacing: 14) {
                Text("输入你要连接的服务器地址")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(AppTheme.secondaryText(colorScheme))

                TextField("https://your-server.example.com", text: $serverText)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .authTextFieldStyle()

                AuthPrimaryButton(
                    title: "Continue",
                    disabled: appState.isWorking || serverText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                ) {
                    Task { await checkServer() }
                }

                Text("我们会先检查这个链接是否可用，然后再让你输入账号密码登录。")
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.secondaryText(colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let error = appState.authError {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .overlay {
            if appState.isWorking {
                ProgressView()
                    .controlSize(.large)
            }
        }
    }

    private func checkServer() async {
        if let url = await appState.checkServer(serverText) {
            onServerReady(url)
        }
    }
}

private struct PasswordLoginView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.colorScheme) private var colorScheme

    let serverURL: URL
    let onBack: () -> Void
    let onCancel: () -> Void

    @State private var userId = ""
    @State private var password = ""

    var body: some View {
        AuthScreen(
            title: "Sign In",
            showsBack: true,
            onBack: onBack,
            onCancel: onCancel,
        ) {
            VStack(alignment: .leading, spacing: 14) {
                Text("输入账号密码")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(AppTheme.secondaryText(colorScheme))

                Text(serverURL.absoluteString)
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.secondaryText(colorScheme))
                    .lineLimit(2)

                TextField("User ID", text: $userId)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .authTextFieldStyle()

                SecureField("Password", text: $password)
                    .authTextFieldStyle()

                AuthPrimaryButton(
                    title: "Sign In",
                    disabled: appState.isWorking || userId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty,
                ) {
                    Task { await signIn() }
                }
            }

            if let error = appState.authError {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .overlay {
            if appState.isWorking {
                ProgressView()
                    .controlSize(.large)
            }
        }
    }

    private func signIn() async {
        await appState.login(serverURL: serverURL, userId: userId, password: password)
        if case .signedIn = appState.route {
            onCancel()
        }
    }
}

#Preview {
    EnterServerView()
        .environmentObject(AppState())
}

