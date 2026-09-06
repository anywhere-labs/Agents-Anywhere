import SwiftUI

struct PasswordSettingsView: View {
    @EnvironmentObject private var appState: AppState

    @State private var password = ""
    @State private var confirmation = ""
    @State private var confirmsDiscard = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Form {
            Section {
                SecureField(String(localized: "New password"), text: $password)
                    .textContentType(.newPassword)
                SecureField(String(localized: "Confirm password"), text: $confirmation)
                    .textContentType(.newPassword)
            } footer: {
                Text(String(localized: "Use at least 8 characters. Changing the password does not sign out this device."))
            }

        }
        .navigationTitle(String(localized: "Password"))
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden()
        .toolbar {
            SheetEditorToolbar(isWorking: appState.isAccountWorking,
                saveDisabled: password.count < 8 || password != confirmation,
                onCancel: { if password.isEmpty && confirmation.isEmpty { dismiss() } else { confirmsDiscard = true } },
                onSave: savePassword)
        }
        .interactiveDismissDisabled(!password.isEmpty || !confirmation.isEmpty || appState.isAccountWorking)
        .confirmDiscardChanges($confirmsDiscard) { dismiss() }

    }

    private func savePassword() {
        Task {
            let saved = await appState.changeAccountPassword(
                newPassword: password,
                confirmation: confirmation
            )
            if saved {
                password = ""
                confirmation = ""
                dismiss()
            }
        }
    }
}
