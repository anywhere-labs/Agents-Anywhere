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
                        userId: me.userId,
                        role: me.role,
                        disabled: me.disabled,
                        avatarSource: appState.accountAvatarSource
                    )

                    AccountSettingsNavigationSection()
                }

                AccountSettingsServerSection(serverURL: appState.serverURL)
                AccountSettingsAboutSection()

                Section {
                    Button("Sign out", role: .destructive) {
                        isConfirmingSignOut = true
                    }
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
            .refreshable {
                _ = await appState.refreshAccount()
            }
            .alert("Account update failed", isPresented: accountErrorBinding) {
                Button("OK", role: .cancel) {
                    appState.dismissAccountError()
                }
            } message: {
                Text(appState.accountError ?? "")
            }
            .confirmationDialog(
                "Sign out of this server?",
                isPresented: $isConfirmingSignOut,
                titleVisibility: .visible
            ) {
                Button("Sign out", role: .destructive, action: signOut)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("You will need to connect to the server again to continue.")
            }
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

    private func signOut() {
        dismiss()
        appState.signOut()
    }
}

private struct AccountSettingsProfileSection: View {
    let userId: String
    let role: UserRole
    let disabled: Bool
    let avatarSource: AccountAvatarImageSource?

    var body: some View {
        Section {
            HStack(spacing: 16) {
                AccountAvatarView(userId: userId, source: avatarSource, size: 64)

                VStack(alignment: .leading, spacing: 4) {
                    Text(userId)
                        .font(.headline)
                    if role == .admin {
                        Text("Administrator")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("Member")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    if disabled {
                        Label("Disabled", systemImage: "xmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.red)
                    } else {
                        Label("Active", systemImage: "checkmark.circle.fill")
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
    var body: some View {
        Section("Account") {
            NavigationLink {
                AvatarSettingsView()
            } label: {
                Label("Profile photo", systemImage: "person.crop.circle")
            }

            NavigationLink {
                PasswordSettingsView()
            } label: {
                Label("Password", systemImage: "key")
            }
        }

        Section("Preferences") {
            NavigationLink {
                AppearanceSettingsView()
            } label: {
                Label("Appearance", systemImage: "circle.lefthalf.filled")
            }
        }
    }
}

private struct AccountSettingsServerSection: View {
    let serverURL: URL?

    var body: some View {
        Section("Server") {
            if let serverURL {
                LabeledContent("Status", value: "Connected")
                LabeledContent("Address") {
                    Text(serverURL.absoluteString)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                }
                Button {
                    UIPasteboard.general.string = serverURL.absoluteString
                } label: {
                    Label("Copy server address", systemImage: "doc.on.doc")
                }
            } else {
                ContentUnavailableView(
                    "Server unavailable",
                    systemImage: "network.slash"
                )
            }
        }
    }
}

private struct AccountSettingsAboutSection: View {
    var body: some View {
        Section("About") {
            LabeledContent("Version", value: version)
            LabeledContent("Build", value: build)
        }
    }

    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "-"
    }

    private var build: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "-"
    }
}
