import SwiftUI
import UIKit

struct AccountSettingsSheet: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var isConfirmingSignOut = false

    var body: some View {
        NavigationStack {
            List {
                if let me = appState.me {
                    AccountSettingsProfileSection(
                        displayName: me.accountLabel,
                        email: me.email,
                        role: me.role,
                        disabled: me.disabled,
                        avatarSource: appState.accountAvatarSource
                    )

                    AccountSettingsNavigationSection()
                }

                AccountSettingsServerSection(serverURL: appState.serverURL)
                AccountSettingsAboutSection()

                Section {
                    Button(String(localized: "Sign out"), role: .destructive) {
                        isConfirmingSignOut = true
                    }
                }
            }
            .navigationTitle(String(localized: "Settings"))
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Done")) {
                        dismiss()
                    }
                }
            }
            .refreshable {
                _ = await appState.refreshAccount()
            }
            .alert(String(localized: "Account update failed"), isPresented: accountErrorBinding) {
                Button(String(localized: "OK"), role: .cancel) {
                    appState.dismissAccountError()
                }
            } message: {
                Text(appState.accountError ?? "")
            }
        }
        .sheet(isPresented: $isConfirmingSignOut) {
            SignOutConfirmationSheet(onSignOut: signOut)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private var accountErrorBinding: Binding<Bool> {
        Binding(
            get: { appState.accountError != nil },
            set: { isPresented in
                if !isPresented {
                    appState.dismissAccountError()
                }
            }
        )
    }

    private func signOut() throws {
        try appState.signOutAndDeleteCredentials()
    }
}

private struct SignOutConfirmationSheet: View {
    let onSignOut: () throws -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var errorMessage = ""
    @State private var isShowingError = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Spacer()

                AppSymbol("rectangle.portrait.and.arrow.forward", size: 42)
                    .foregroundStyle(.secondary)

                Text(String(localized: "Sign out?"))
                    .font(.largeTitle.bold())

                Text(String(localized: "Your saved credentials will be removed from this device. You will need to sign in again to reconnect."))
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 420)

                Spacer()

                Button(role: .destructive, action: confirmSignOut) {
                    Label(String(localized: "Sign out"), appSymbol: "rectangle.portrait.and.arrow.forward")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.large)
                .tint(.red)
                .foregroundStyle(.white)

                Button(action: dismiss.callAsFunction) {
                    Text(String(localized: "Cancel"))
                        .frame(maxWidth: .infinity)
                }
                    .buttonStyle(.glass)
                    .buttonBorderShape(.capsule)
                    .controlSize(.large)
            }
            .padding(24)
            .navigationTitle(String(localized: "Sign out"))
            .navigationBarTitleDisplayMode(.inline)
        }
        .alert(String(localized: "Could not sign out"), isPresented: $isShowingError) {
            Button(String(localized: "OK"), role: .cancel) {}
        } message: {
            Text(errorMessage)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.hidden)
        .interactiveDismissDisabled()
    }

    /// Deletes credentials and closes the cover only after the signed-out route is active.
    private func confirmSignOut() {
        do {
            try onSignOut()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
            isShowingError = true
        }
    }
}

private struct AccountSettingsProfileSection: View {
    let displayName: String
    let email: String?
    let role: UserRole
    let disabled: Bool
    let avatarSource: AccountAvatarImageSource?

    var body: some View {
        Section {
            HStack(spacing: 16) {
                AccountAvatarView(displayName: displayName, source: avatarSource, size: 64)

                VStack(alignment: .leading, spacing: 4) {
                    Text(displayName)
                        .font(.headline)
                    if let email {
                        Text(email)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    if role == .admin {
                        Text(String(localized: "Administrator"))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    } else {
                        Text(String(localized: "Member"))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    if disabled {
                        Label(String(localized: "Disabled"), appSymbol: "xmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.red)
                    } else {
                        Label(String(localized: "Active"), appSymbol: "checkmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.green)
                    }
                }
            }
            .padding(.vertical, 6)
        }
    }
}

private struct AccountSettingsNavigationSection: View {
    @Environment(\.openURL) private var openURL
    var body: some View {
        Section(String(localized: "Account")) {
            NavigationLink {
                AccountIdentitySettingsView()
            } label: {
                Label(String(localized: "Nickname and email"), appSymbol: "person.text.rectangle")
            }

            NavigationLink {
                AvatarSettingsView()
            } label: {
                Label(String(localized: "Profile photo"), appSymbol: "person.crop.circle")
            }

            NavigationLink {
                PasswordSettingsView()
            } label: {
                Label(String(localized: "Password"), appSymbol: "key")
            }
        }

        Section(String(localized: "Preferences")) {
            NavigationLink {
                AppearanceSettingsView()
            } label: {
                Label(String(localized: "Appearance"), appSymbol: "circle.lefthalf.filled")
            }
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
            } label: {
                HStack {
                    Label(String(localized: "Language"), appSymbol: "globe")
                    Spacer()
                    Text(Bundle.main.preferredLocalizations.first?.hasPrefix("zh") == true ? "简体中文" : "English")
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityHint(String(localized: "Change the app language in iOS Settings."))
        }
    }
}

private struct AccountSettingsServerSection: View {
    let serverURL: URL?

    var body: some View {
        Section(String(localized: "Server")) {
            if let serverURL {
                LabeledContent(String(localized: "Status"), value: String(localized: "Connected"))
                LabeledContent(String(localized: "Address")) {
                    Text(serverURL.absoluteString)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                }
                Button {
                    UIPasteboard.general.string = serverURL.absoluteString
                } label: {
                    Label(String(localized: "Copy server address"), appSymbol: "doc.on.doc")
                }
            } else {
                ContentUnavailableView(
                    String(localized: "Server unavailable"),
                    systemImage: "network.slash"
                )
            }
        }
    }
}

private struct AccountSettingsAboutSection: View {
    var body: some View {
        Section(String(localized: "About")) {
            LabeledContent(String(localized: "Version"), value: version)
            LabeledContent(String(localized: "Build"), value: build)
        }
    }

    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "-"
    }

    private var build: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "-"
    }
}
