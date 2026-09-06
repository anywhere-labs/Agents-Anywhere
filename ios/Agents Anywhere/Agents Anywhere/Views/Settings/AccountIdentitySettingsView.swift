import SwiftUI

struct AccountIdentitySettingsView: View {
    @EnvironmentObject private var appState: AppState

    @State private var displayName = ""
    @State private var email = ""
    @State private var code = ""
    @State private var config: AuthConfig?
    @State private var isLoadingConfig = true
    @State private var isWorking = false
    @State private var cooldown = 0
    @State private var codeSent = false
    @State private var errorMessage: String?
    @State private var isShowingError = false
    @State private var successMessage = ""
    @State private var isShowingSuccess = false

    private var normalizedDisplayName: String {
        displayName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var normalizedEmail: String {
        email.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var validEmail: Bool {
        normalizedEmail.range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#, options: .regularExpression) != nil
    }

    private var verificationRequired: Bool {
        config?.emailVerificationRequired == true
    }

    var body: some View {
        Form {
            Section(String(localized: "Nickname")) {
                TextField(String(localized: "Nickname"), text: $displayName)
                    .textContentType(.nickname)
                Button(String(localized: "Save nickname"), action: saveDisplayName)
                    .disabled(!(1...64).contains(normalizedDisplayName.count) || isWorking)
            }

            Section {
                if let me = appState.me,
                   let savedEmail = me.email,
                   normalizedEmail.lowercased() == savedEmail.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
                    LabeledContent(String(localized: "Email status")) {
                        Text(me.emailVerified ? String(localized: "Verified") : String(localized: "Not verified"))
                    }
                }
                TextField(String(localized: "Email"), text: $email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onChange(of: email) {
                        code = ""
                        codeSent = false
                    }

                if isLoadingConfig {
                    ProgressView(String(localized: "Loading email settings…"))
                } else if config == nil {
                    Button(String(localized: "Retry loading email settings")) {
                        Task { await loadConfig() }
                    }
                } else if verificationRequired {
                    TextField(String(localized: "Email verification code"), text: $code)
                        .textContentType(.oneTimeCode)
                        .keyboardType(.numberPad)
                        .onChange(of: code) {
                            code = String(code.filter(\.isNumber).prefix(6))
                        }
                    Button(action: sendCode) {
                        if cooldown > 0 {
                            Text(String(localized: "Resend in \(cooldown) s"))
                        } else {
                            Text(String(localized: "Send verification code"))
                        }
                    }
                    .disabled(!validEmail || cooldown > 0 || isWorking)
                    if codeSent {
                        Text(String(localized: "Code sent. Check your inbox."))
                            .foregroundStyle(.secondary)
                    }
                }

                Button(String(localized: "Save email"), action: saveEmail)
                    .disabled(config == nil || !validEmail || isWorking || (verificationRequired && code.count != 6))
            } header: {
                Text(String(localized: "Link or change email"))
            } footer: {
                if let config, !config.emailVerificationRequired {
                    Text(String(localized: "This service accepts email without a verification code."))
                }
            }

            if isWorking {
                Section { ProgressView() }
            }
        }
        .disabled(isWorking)
        .navigationTitle(String(localized: "Nickname and email"))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            displayName = appState.me?.displayName ?? ""
            email = appState.me?.email ?? ""
            await loadConfig()
        }
        .task(id: cooldown) {
            guard cooldown > 0 else { return }
            do {
                try await Task.sleep(for: .seconds(1))
                cooldown -= 1
            } catch {}
        }
        .alert(String(localized: "Account update failed"), isPresented: $isShowingError) {
            Button(String(localized: "OK"), role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
        .alert(String(localized: "Account updated"), isPresented: $isShowingSuccess) {
            Button(String(localized: "OK"), role: .cancel) {}
        } message: {
            Text(successMessage)
        }
    }

    private func loadConfig() async {
        isLoadingConfig = true
        defer { isLoadingConfig = false }
        do {
            config = try await appState.accountAuthConfig()
        } catch is CancellationError {
            return
        } catch {
            showError(error)
        }
    }

    private func saveDisplayName() {
        Task {
            isWorking = true
            defer { isWorking = false }
            do {
                try await appState.updateAccountProfile(displayName: normalizedDisplayName)
                displayName = appState.me?.displayName ?? normalizedDisplayName
                successMessage = String(localized: "Your nickname has been updated.")
                isShowingSuccess = true
            } catch {
                showError(error)
            }
        }
    }

    private func sendCode() {
        Task {
            isWorking = true
            defer { isWorking = false }
            do {
                let response = try await appState.sendAccountEmailCode(email: normalizedEmail)
                cooldown = max(response.retryAfter, 1)
                codeSent = true
            } catch {
                showError(error)
            }
        }
    }

    private func saveEmail() {
        Task {
            isWorking = true
            defer { isWorking = false }
            do {
                try await appState.bindAccountEmail(email: normalizedEmail, code: verificationRequired ? code : nil)
                email = appState.me?.email ?? normalizedEmail
                code = ""
                codeSent = false
                successMessage = String(localized: "Use your email address the next time you sign in.")
                isShowingSuccess = true
            } catch {
                showError(error)
            }
        }
    }

    private func showError(_ error: Error) {
        errorMessage = error.localizedDescription
        isShowingError = true
    }
}
