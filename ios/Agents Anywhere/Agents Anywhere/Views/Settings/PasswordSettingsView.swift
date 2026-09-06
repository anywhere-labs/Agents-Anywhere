import SwiftUI

struct PasswordSettingsView: View {
    @EnvironmentObject private var appState: AppState

    @Binding var draft: AccountPasswordDraft
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Form {
            Section(String(localized: "New password")) {
                SecureField(String(localized: "New password"), text: $draft.password)
                    .textContentType(.newPassword)
            }
            Section {
                SecureField(String(localized: "Confirm password"), text: $draft.confirmation)
                    .textContentType(.newPassword)
            } header: {
                Text(String(localized: "Confirm password"))
            } footer: {
                Text(String(localized: "Use at least 8 characters. Changing the password does not sign out this device."))
            }

        }
        .textFieldStyle(.roundedBorder)
        .navigationTitle(String(localized: "Password"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            SheetSaveToolbar(isWorking: appState.isAccountWorking,
                saveDisabled: draft.password.count < 8 || draft.password != draft.confirmation,
                onSave: savePassword)
        }
        .disabled(appState.isAccountWorking)
    }

    private func savePassword() {
        Task {
            let saved = await appState.changeAccountPassword(
                newPassword: draft.password,
                confirmation: draft.confirmation
            )
            if saved {
                draft = AccountPasswordDraft()
                dismiss()
            }
        }
    }
}
