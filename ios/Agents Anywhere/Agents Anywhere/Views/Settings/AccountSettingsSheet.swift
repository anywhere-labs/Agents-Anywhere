import SwiftUI

struct AccountSettingsSheet: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @AppStorage(AppAppearance.storageKey) private var appearanceValue = AppAppearance.system.rawValue
    @AppStorage(ProjectSidebarPreferences.sessionListKey) private var showsSessionList = false
    @State private var confirmsSignOut = false
    @State private var signOutError: String?
    @State private var toasts = ChatToastStore()

    var body: some View {
        NavigationStack {
            List {
                if let me = appState.me {
                    Section {
                        HStack(spacing: 16) {
                            AccountAvatarView(displayName: me.accountLabel, source: appState.accountAvatarSource, size: 60)
                            VStack(alignment: .leading, spacing: 5) {
                                Text(me.accountLabel).font(.title3.weight(.semibold))
                                if let email = me.email { Text(email).font(.subheadline).foregroundStyle(.secondary) }
                                Text(me.role == .admin ? String(localized: "Administrator") : String(localized: "Member"))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                        }.padding(.vertical, 12)
                    }.listRowBackground(Color.clear).listRowSeparator(.hidden)

                    Section(String(localized: "Account")) {
                        NavigationLink { AccountIdentitySettingsView(mode: .nickname) } label: {
                            SettingsRow(title: String(localized: "Nickname"), symbol: "person.text.rectangle", value: me.displayName)
                        }
                        NavigationLink { AccountIdentitySettingsView(mode: .email) } label: {
                            SettingsRow(title: String(localized: "Email"), symbol: "envelope", value: me.email)
                        }
                        NavigationLink { AvatarSettingsView() } label: {
                            SettingsRow(title: String(localized: "Profile photo"), symbol: "person.crop.circle")
                        }
                        NavigationLink { PasswordSettingsView() } label: {
                            SettingsRow(title: String(localized: "Password"), symbol: "key")
                        }
                    }
                }

                Section(String(localized: "App")) {
                    NavigationLink { AppearanceSettingsView() } label: {
                        SettingsRow(title: String(localized: "Appearance"), symbol: "circle.lefthalf.filled",
                            value: String(localized: (AppAppearance(rawValue: appearanceValue) ?? .system).title))
                    }
                    NavigationLink { SettingsLanguageView() } label: {
                        SettingsRow(title: String(localized: "Language"), symbol: "globe", value: SettingsLanguageView.currentLanguage)
                    }
                }
                Section(String(localized: "Workspace")) {
                    Toggle(isOn: $showsSessionList) {
                        SettingsRow(title: String(localized: "侧边栏显示会话"), symbol: "sidebar.left")
                    }.tint(.green)
                    NavigationLink { SettingsServerView() } label: {
                        SettingsRow(title: String(localized: "Server"), symbol: "server.rack", value: appState.serverURL?.host)
                    }
                }
                Section {
                    NavigationLink { SettingsAboutView() } label: {
                        SettingsRow(title: String(localized: "About"), symbol: "info.circle")
                    }
                }
                Section {
                    Button(role: .destructive) { confirmsSignOut = true } label: {
                        SettingsRow(title: String(localized: "Sign out"), symbol: "rectangle.portrait.and.arrow.forward")
                            .foregroundStyle(.red)
                    }.disabled(appState.isAccountWorking)
                } footer: {
                    Text("Agents Anywhere · \(SettingsAboutView.version)")
                        .font(.footnote).frame(maxWidth: .infinity).padding(.top, 16)
                }
            }
            .listStyle(.insetGrouped).scrollContentBackground(.hidden)
            .background(Color(uiColor: .systemBackground))
            .navigationTitle(String(localized: "Settings")).navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetCloseToolbar(disabled: appState.isAccountWorking) { dismiss() } }
            .refreshable { _ = await appState.refreshAccount() }
            .alert(String(localized: "Sign out?"), isPresented: $confirmsSignOut) {
                Button(String(localized: "Cancel"), role: .cancel) {}
                Button(String(localized: "Sign out"), role: .destructive, action: signOut)
            } message: {
                Text(String(localized: "Your saved credentials will be removed from this device. You will need to sign in again to reconnect."))
            }
            .alert(String(localized: "Could not sign out"), isPresented: Binding(get: { signOutError != nil }, set: { if !$0 { signOutError = nil } })) {
                Button(String(localized: "OK"), role: .cancel) { signOutError = nil }
            } message: { Text(signOutError ?? "") }
        }
        .overlay(alignment: .top) { ChatErrorToasts(store: toasts, isRetrying: false, onRetry: { _ in }) }
        .onChange(of: appState.accountError) { _, error in
            guard let error else { return }
            toasts.update(source: "account", failure: .init(kind: .rejected, message: error))
            appState.dismissAccountError()
        }
        .environment(\.closeSettings, { dismiss() })
        .presentationDetents([.large]).presentationDragIndicator(.visible)
        .interactiveDismissDisabled(appState.isAccountWorking)
    }

    private func signOut() {
        do { try appState.signOutAndDeleteCredentials(); dismiss() }
        catch { signOutError = error.localizedDescription }
    }
}
