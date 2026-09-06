import SwiftUI

struct PasswordSettingsView: View {
    @EnvironmentObject private var appState: AppState

    @State private var password = ""
    @State private var confirmation = ""
    @State private var isShowingSuccess = false

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

            Section {
                Button(action: savePassword) {
                    HStack {
                        Spacer()
                        if appState.isAccountWorking {
                            ProgressView()
                                .controlSize(.small)
                        }
                        Text(String(localized: "Save password"))
                        Spacer()
                    }
                }
                .disabled(password.isEmpty || confirmation.isEmpty || appState.isAccountWorking)
            }
        }
        .navigationTitle(String(localized: "Password"))
        .navigationBarTitleDisplayMode(.inline)
        .alert(String(localized: "Password updated"), isPresented: $isShowingSuccess) {
            Button(String(localized: "OK"), role: .cancel) {}
        } message: {
            Text(String(localized: "Your new password will be used the next time you sign in."))
        }
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
                isShowingSuccess = true
            }
        }
    }
}
