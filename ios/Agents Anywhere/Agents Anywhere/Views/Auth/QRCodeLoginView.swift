import SwiftUI

struct QRCodeLoginView: View {
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
                        onBack: { _ = path.popLast() },
                        onCancel: { dismiss() },
                        onWaiting: {
                            path.append(.waiting(payload))
                        },
                    )
                case let .waiting(payload):
                    QRWaitingStepView(
                        payload: payload,
                        onBack: { _ = path.popLast() },
                        onCancel: { dismiss() },
                    )
                }
            }
        }
    }
}

private enum QRLoginRoute: Hashable {
    case confirm(MobileLoginPayload)
    case waiting(MobileLoginPayload)
}

private struct QRScanStepView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.colorScheme) private var colorScheme

    let onCancel: () -> Void
    let onPayload: (MobileLoginPayload) -> Void

    @State private var qrJSON = ""
    @State private var parseError: String?
    @State private var showingManualEntry = false

    var body: some View {
        AuthScreen(
            title: "QR Code Login",
            showsBack: false,
            onBack: nil,
            onCancel: onCancel,
        ) {
            VStack(alignment: .leading, spacing: 16) {
                ZStack(alignment: .bottom) {
                    QRCodeScannerView(
                        onCode: { value in
                            qrJSON = value
                            parsePayload()
                        },
                        onError: { message in
                            parseError = message
                        },
                    )
                    .frame(height: 360)
                    .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))

                    Text("Scan the QR code from Web Settings")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .background(AppTheme.glassScrim(colorScheme), in: Capsule())
                        .padding(.bottom, 18)
                }

                DisclosureGroup("Paste QR JSON manually", isExpanded: $showingManualEntry) {
                    VStack(spacing: 12) {
                        TextEditor(text: $qrJSON)
                            .frame(minHeight: 140)
                            .font(.system(.body, design: .monospaced))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .authTextFieldStyle()

                        AuthPrimaryButton(
                            title: "Parse JSON",
                            disabled: qrJSON.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                        ) {
                            parsePayload()
                        }
                    }
                    .padding(.top, 12)
                }
                .foregroundStyle(AppTheme.primaryText(colorScheme))
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

    private func parsePayload() {
        parseError = nil
        do {
            let data = Data(qrJSON.utf8)
            let decoded = try JSONDecoder().decode(MobileLoginPayload.self, from: data)
            guard decoded.type == "agents-anywhere.mobile-login", decoded.version == 1 else {
                parseError = "This is not an Agents Anywhere mobile login QR code."
                return
            }
            onPayload(decoded)
        } catch {
            parseError = "Invalid QR JSON: \(error.localizedDescription)"
        }
    }
}

private struct QRConfirmStepView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.colorScheme) private var colorScheme

    let payload: MobileLoginPayload
    let onBack: () -> Void
    let onCancel: () -> Void
    let onWaiting: () -> Void

    var body: some View {
        AuthScreen(
            title: "Confirm Login",
            showsBack: true,
            onBack: onBack,
            onCancel: onCancel,
        ) {
            VStack(alignment: .leading, spacing: 14) {
                Image(systemName: "person.crop.circle.badge.checkmark")
                    .font(.system(size: 46, weight: .semibold))
                    .foregroundStyle(AppTheme.primaryText(colorScheme))

                Text("Sign in as \(payload.userId)?")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(AppTheme.primaryText(colorScheme))

                Text("This will connect this iPhone to \(payload.webUrl).")
                    .foregroundStyle(AppTheme.secondaryText(colorScheme))
            }

            VStack(alignment: .leading, spacing: 10) {
                Text("Login request")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppTheme.secondaryText(colorScheme))

                VStack(spacing: 10) {
                    requestRow("Server", payload.webUrl)
                    Divider()
                    requestRow("User", payload.userId)
                    Divider()
                    requestRow("Expires", payload.expiresAt)
                }
                .padding(18)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            }

            AuthPrimaryButton(
                title: "Yes, Continue",
                disabled: appState.isWorking,
            ) {
                Task { await beginWebConfirmation() }
            }

            HStack {
                Spacer()
                AuthGlassButton("Scan Another Code", role: .destructive, action: onBack)
                Spacer()
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

    private func requestRow(_ title: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(.headline)
                .foregroundStyle(AppTheme.primaryText(colorScheme))
            Spacer(minLength: 18)
            Text(value)
                .font(.headline)
                .foregroundStyle(AppTheme.secondaryText(colorScheme))
                .multilineTextAlignment(.trailing)
        }
    }

    private func beginWebConfirmation() async {
        if await appState.requestMobileLogin(payload: payload) {
            onWaiting()
        }
    }
}

private struct QRWaitingStepView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.colorScheme) private var colorScheme

    let payload: MobileLoginPayload
    let onBack: () -> Void
    let onCancel: () -> Void

    @State private var status: MobileLoginStatusResponse?
    @State private var pollingTask: Task<Void, Never>?
    @State private var failedMessage: String?

    var body: some View {
        AuthScreen(
            title: "Waiting",
            showsBack: true,
            onBack: onBack,
            onCancel: onCancel,
        ) {
            VStack(spacing: 18) {
                ProgressView()
                    .controlSize(.large)
                Text("Confirm login on Web")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(AppTheme.primaryText(colorScheme))
                Text("Open the web browser where you generated this QR code and click confirm. This app will finish signing in automatically.")
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.secondaryText(colorScheme))
                    .multilineTextAlignment(.center)
                if let status {
                    Text(statusText(status.status))
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(AppTheme.secondaryText(colorScheme))
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 28)

            if let failedMessage {
                Text(failedMessage)
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
        .onAppear {
            startPolling()
        }
        .onDisappear {
            stopPolling()
        }
    }

    private func startPolling() {
        stopPolling()
        pollingTask = Task {
            while !Task.isCancelled {
                if let next = await appState.mobileLoginStatus(payload: payload) {
                    status = next
                    if next.status == "approved" {
                        await appState.exchangeMobileLogin(payload: payload)
                        if case .signedIn = appState.route {
                            onCancel()
                        }
                        return
                    }
                    if next.status == "rejected" || next.status == "expired" || next.status == "consumed" {
                        failedMessage = statusText(next.status)
                        return
                    }
                }
                try? await Task.sleep(for: .seconds(1.5))
            }
        }
    }

    private func stopPolling() {
        pollingTask?.cancel()
        pollingTask = nil
    }

    private func statusText(_ value: String) -> String {
        switch value {
        case "pending_web_confirm":
            return "Waiting for web confirmation"
        case "approved":
            return "Approved. Signing in..."
        case "rejected":
            return "Rejected"
        case "expired":
            return "Expired"
        case "consumed":
            return "Already used"
        default:
            return "Waiting for scan"
        }
    }
}

#Preview {
    QRCodeLoginView()
        .environmentObject(AppState())
}
