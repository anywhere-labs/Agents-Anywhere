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
            Section("Nickname") {
                TextField("Nickname", text: $displayName)
                    .textContentType(.nickname)
                Button("Save nickname", action: saveDisplayName)
                    .disabled(!(1...64).contains(normalizedDisplayName.count) || isWorking)
            }

            Section {
                if let me = appState.me,
                   let savedEmail = me.email,
                   normalizedEmail.lowercased() == savedEmail.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
                    LabeledContent("Email status") {
                        Text(me.emailVerified ? "Verified" : "Not verified")
                    }
                }
                TextField("Email", text: $email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onChange(of: email) {
                        code = ""
                        codeSent = false
                    }

                if isLoadingConfig {
                    ProgressView("Loading email settings…")
                } else if config == nil {
                    Button("Retry loading email settings") {
                        Task { await loadConfig() }
                    }
                } else if verificationRequired {
                    TextField("Email verification code", text: $code)
                        .textContentType(.oneTimeCode)
                        .keyboardType(.numberPad)
                        .onChange(of: code) {
                            code = String(code.filter(\.isNumber).prefix(6))
                        }
                    Button(action: sendCode) {
                        if cooldown > 0 {
                            Text("Resend in \(cooldown) s")
                        } else {
                            Text("Send verification code")
                        }
                    }
                    .disabled(!validEmail || cooldown > 0 || isWorking)
                    if codeSent {
                        Text("Code sent. Check your inbox.")
                            .foregroundStyle(.secondary)
                    }
                }

                Button("Save email", action: saveEmail)
                    .disabled(config == nil || !validEmail || isWorking || (verificationRequired && code.count != 6))
            } header: {
                Text("Link or change email")
            } footer: {
                if let config, !config.emailVerificationRequired {
                    Text("This service accepts email without a verification code.")
                }
            }

            if isWorking {
                Section { ProgressView() }
            }
        }
        .disabled(isWorking)
        .navigationTitle("Nickname and email")
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
        .alert("Account update failed", isPresented: $isShowingError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
        .alert("Account updated", isPresented: $isShowingSuccess) {
            Button("OK", role: .cancel) {}
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
