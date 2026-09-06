import SwiftUI

struct AccountIdentitySettingsView: View {
    enum Mode { case nickname, email }
    let mode: Mode
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var initialText = ""
    @State private var code = ""
    @State private var config: AuthConfig?
    @State private var isLoadingConfig = false
    @State private var isWorking = false
    @State private var didInitialize = false
    @State private var cooldown = 0
    @State private var codeSent = false
    @State private var error: String?
    @State private var confirmsDiscard = false

    private var normalized: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var title: String { mode == .nickname ? String(localized: "Nickname") : String(localized: "Email") }
    private var validEmail: Bool { normalized.range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#, options: .regularExpression) != nil }
    private var verificationRequired: Bool { config?.emailVerificationRequired == true }
    private var hasChanges: Bool { text != initialText || !code.isEmpty }
    private var canSave: Bool {
        mode == .nickname ? (1...64).contains(normalized.count) && text != initialText :
            config != nil && validEmail && (text != initialText || appState.me?.emailVerified != true) && (!verificationRequired || code.count == 6)
    }

    var body: some View {
        Form {
            Section {
                TextField(title, text: $text)
                    .textContentType(mode == .nickname ? .nickname : .emailAddress)
                    .keyboardType(mode == .email ? .emailAddress : .default)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .onChange(of: text) { _, _ in code = ""; codeSent = false }
            }
            if mode == .email {
                if text == initialText && !initialText.isEmpty {
                    Section {
                        LabeledContent(String(localized: "Email status"),
                            value: appState.me?.emailVerified == true ? String(localized: "Verified") : String(localized: "Not verified"))
                    }
                }
                Section {
                    if isLoadingConfig {
                        ProgressView(String(localized: "Loading email settings…"))
                    } else if config == nil {
                        Button(String(localized: "Retry loading email settings")) { Task { await loadConfig() } }
                    } else if verificationRequired {
                        TextField(String(localized: "Email verification code"), text: $code)
                            .textContentType(.oneTimeCode).keyboardType(.numberPad)
                            .onChange(of: code) { _, _ in code = String(code.filter(\.isNumber).prefix(6)) }
                        Button(cooldown > 0 ? String(localized: "Resend in \(cooldown) s") : String(localized: "Send verification code"), action: sendCode)
                            .disabled(!validEmail || cooldown > 0 || isWorking)
                        if codeSent { Text(String(localized: "Code sent. Check your inbox.")).foregroundStyle(.secondary) }
                    }
                } footer: {
                    if let config, !config.emailVerificationRequired {
                        Text(String(localized: "This service accepts email without a verification code."))
                    }
                }
            }
        }
        .disabled(isWorking)
        .navigationTitle(title).navigationBarTitleDisplayMode(.inline).navigationBarBackButtonHidden()
        .toolbar { SheetEditorToolbar(isWorking: isWorking, saveDisabled: !canSave, onCancel: cancel, onSave: save) }
        .interactiveDismissDisabled(hasChanges || isWorking)
        .confirmDiscardChanges($confirmsDiscard) { dismiss() }
        .task {
            guard !didInitialize else { return }; didInitialize = true
            text = mode == .nickname ? appState.me?.displayName ?? "" : appState.me?.email ?? ""
            initialText = text
            if mode == .email { await loadConfig() }
        }
        .task(id: cooldown) {
            guard cooldown > 0 else { return }
            do { try await Task.sleep(for: .seconds(1)); cooldown -= 1 } catch {}
        }
        .alert(String(localized: "Account update failed"), isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button(String(localized: "OK"), role: .cancel) { error = nil }
        } message: { Text(error ?? "") }
    }

    private func cancel() { if hasChanges { confirmsDiscard = true } else { dismiss() } }
    private func loadConfig() async {
        isLoadingConfig = true
        defer { isLoadingConfig = false }
        do { config = try await appState.accountAuthConfig() }
        catch is CancellationError {}
        catch { self.error = error.localizedDescription }
    }
    private func save() {
        guard canSave, !isWorking else { return }
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        isWorking = true
        Task {
            await Task.yield()
            defer { isWorking = false }
            do {
                if mode == .nickname { try await appState.updateAccountProfile(displayName: normalized) }
                else { try await appState.bindAccountEmail(email: normalized, code: verificationRequired ? code : nil) }
                initialText = text; code = ""; dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
    private func sendCode() {
        guard !isWorking, validEmail, cooldown == 0 else { return }
        isWorking = true
        Task {
            defer { isWorking = false }
            do {
                let response = try await appState.sendAccountEmailCode(email: normalized)
                cooldown = max(response.retryAfter, 1); codeSent = true
            } catch { self.error = error.localizedDescription }
        }
    }
}
