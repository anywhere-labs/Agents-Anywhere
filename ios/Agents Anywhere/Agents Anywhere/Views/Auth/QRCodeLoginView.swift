import SwiftUI

struct QRCodeLoginView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var path: [QRLoginRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            QRScanStepView(
                onCancel: { dismiss() },
                onPayload: { payload in
                    path.append(.confirm(payload))
                },
            )
            .navigationDestination(for: QRLoginRoute.self) { route in
                switch route {
                case let .confirm(payload):
                    QRConfirmStepView(
                        payload: payload,
                        onCancel: { dismiss() },
                        onWaiting: {
                            path.append(.waiting(payload))
                        },
                    )
                case let .waiting(payload):
                    QRWaitingStepView(
                        payload: payload,
                        onCancel: { dismiss() },
                        onReady: {
                            path.append(.complete(payload))
                        },
                    )
                case let .complete(payload):
                    QRCompleteStepView(
                        payload: payload,
                        onCancel: { dismiss() },
                        onSignedIn: {
                            path.append(.success)
                        },
                    )
                case .success:
                    AuthResultView(
                        title: "Login Success",
                        message: "Your iPhone is signed in. Go to your dashboard to continue.",
                        buttonTitle: "Go to Dashboard",
                        buttonSystemImage: "arrow.right",
                        symbolName: "checkmark.circle.fill",
                        symbolColor: .green,
                    ) {
                        Task {
                            await appState.showSignedInRoute()
                            dismiss()
                        }
                    }
                    .navigationBarBackButtonHidden(true)
                }
            }
        }
    }
}

private enum QRLoginRoute: Hashable {
    case confirm(MobileLoginPayload)
    case waiting(MobileLoginPayload)
    case complete(MobileLoginPayload)
    case success
}

private struct QRScanStepView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.colorScheme) private var colorScheme

    let onCancel: () -> Void
    let onPayload: (MobileLoginPayload) -> Void

    @State private var parseError: String?
    @State private var didReadPayload = false

    var body: some View {
        AuthScreen(
            title: "QR Code Login",
            subtitle: "Scan the login QR code from the web console.",
            onCancel: onCancel,
        ) {
            VStack(alignment: .leading, spacing: 16) {
                ZStack(alignment: .bottom) {
                    QRCodeScannerView(
                        onCode: { value in
                            guard !didReadPayload else { return }
                            parsePayload(value)
                        },
                        onError: { message in
                            parseError = message
                        },
                    )
                    .frame(height: 380)
                    .clipShape(RoundedRectangle(cornerRadius: 32, style: .continuous))

                    Text("Point the camera at the web QR code")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .background(AppTheme.glassScrim(colorScheme), in: Capsule())
                        .glassEffect(.regular, in: Capsule())
                        .padding(.bottom, 18)
                }

                if let parseError {
                    Text(parseError)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let error = appState.authError {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func parsePayload(_ value: String) {
        parseError = nil
        do {
            let data = Data(value.utf8)
            let decoded = try JSONDecoder().decode(MobileLoginPayload.self, from: data)
            guard decoded.type == "agents-anywhere.mobile-login", decoded.version == 1 else {
                parseError = "This is not an Agents Anywhere mobile login QR code."
                return
            }
            didReadPayload = true
            onPayload(decoded)
        } catch {
            parseError = "This QR code is not a valid Agents Anywhere login code."
        }
    }
}

private struct QRConfirmStepView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.colorScheme) private var colorScheme

    let payload: MobileLoginPayload
    let onCancel: () -> Void
    let onWaiting: () -> Void

    @State private var isRequesting = false
    @State private var alertMessage: String?

    var body: some View {
        AuthScreen(
            title: "Confirm Login",
            subtitle: "Do you want to sign in as \(payload.userId)?",
            onCancel: onCancel,
        ) {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Server")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(payload.webUrl)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(AppTheme.primaryText(colorScheme))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(AppTheme.groupedFill(colorScheme), in: RoundedRectangle(cornerRadius: 28, style: .continuous))
                .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 28, style: .continuous))

                AuthPrimaryButton(
                    title: "Log In",
                    isLoading: isRequesting,
                ) {
                    Task { await requestWebConfirmation() }
                }
            }
        }
        .alert("Login Request Failed", isPresented: Binding(
            get: { alertMessage != nil },
            set: { if !$0 { alertMessage = nil } },
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(alertMessage ?? "The login request could not be started.")
        }
    }

    private func requestWebConfirmation() async {
        isRequesting = true
        defer { isRequesting = false }
        if await appState.requestMobileLogin(payload: payload) {
            onWaiting()
        } else {
            alertMessage = appState.authError ?? "The login request could not be started."
        }
    }
}

private struct QRWaitingStepView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.colorScheme) private var colorScheme

    let payload: MobileLoginPayload
    let onCancel: () -> Void
    let onReady: () -> Void

    @State private var statusText = "Waiting for confirmation"
    @State private var alertMessage: String?
    @State private var pollingTask: Task<Void, Never>?

    var body: some View {
        AuthScreen(
            title: "Confirm on Web",
            subtitle: "Click confirm in the web console, then return here.",
            onCancel: onCancel,
        ) {
            VStack(spacing: 24) {
                Image(systemName: "desktopcomputer.and.arrow.down")
                    .font(.system(size: 58, weight: .semibold))
                    .foregroundStyle(AppTheme.primaryText(colorScheme))

                Text(statusText)
                    .font(.headline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)

                ProgressView()
                    .controlSize(.large)
                    .tint(AppTheme.primaryText(colorScheme))
                    .padding(.top, 4)
            }
            .padding(.vertical, 24)
        }
        .onAppear {
            startPolling()
        }
        .onDisappear {
            stopPolling()
        }
        .alert("Login Status", isPresented: Binding(
            get: { alertMessage != nil },
            set: { if !$0 { alertMessage = nil } },
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(alertMessage ?? "Confirm the login on the web console and try again.")
        }
    }

    private func startPolling() {
        stopPolling()
        statusText = "Waiting for confirmation"
        pollingTask = Task {
            while !Task.isCancelled {
                let shouldContinue = await pollApprovalOnce()
                if !shouldContinue {
                    return
                }
                try? await Task.sleep(for: .seconds(1.5))
            }
        }
    }

    private func stopPolling() {
        pollingTask?.cancel()
        pollingTask = nil
    }

    @MainActor
    private func pollApprovalOnce() async -> Bool {
        guard let status = await appState.mobileLoginStatus(payload: payload) else {
            alertMessage = appState.authError ?? "Could not check the login status."
            return false
        }

        switch status.status {
        case "approved":
            statusText = "Login confirmed"
            onReady()
            return false
        case "pending_web_confirm":
            statusText = "Waiting for confirmation"
            return true
        case "rejected":
            alertMessage = "This login request was rejected."
            return false
        case "expired":
            alertMessage = "This login request expired. Scan a new QR code."
            return false
        case "consumed":
            alertMessage = "This login request has already been used."
            return false
        default:
            alertMessage = "Current login status: \(status.status)"
            return false
        }
    }
}

private struct QRCompleteStepView: View {
    @EnvironmentObject private var appState: AppState

    let payload: MobileLoginPayload
    let onCancel: () -> Void
    let onSignedIn: () -> Void

    @State private var isFinishing = false
    @State private var didStartLogin = false
    @State private var alertMessage: String?

    var body: some View {
        AuthScreen(
            title: "Completing Login",
            subtitle: "The web console approved this iPhone. Finishing the secure login now.",
            showsCancel: alertMessage != nil,
            onCancel: onCancel,
        ) {
            VStack(alignment: .leading, spacing: 24) {
                LoginSummaryView(
                    server: payload.webUrl,
                    userId: payload.userId,
                )

                HStack(spacing: 12) {
                    ProgressView()
                        .controlSize(.regular)

                    Text(isFinishing ? "Signing in..." : "Preparing login...")
                        .font(.headline)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
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
        .task {
            guard !didStartLogin else { return }
            didStartLogin = true
            await finishLogin()
        }
        .navigationBarBackButtonHidden(true)
    }

    private func finishLogin() async {
        guard !isFinishing else { return }
        isFinishing = true
        defer { isFinishing = false }
        await appState.exchangeMobileLogin(payload: payload, showSignedInRoute: false)
        if appState.me != nil {
            onSignedIn()
        } else {
            alertMessage = appState.authError ?? "The login could not be completed."
        }
    }
}

#Preview {
    QRCodeLoginView()
        .environmentObject(AppState())
}
