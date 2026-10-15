import SwiftUI

/// Adds a further address for the instance the user is signed in to.
/// Flow: validate reachability → OAuth sign-in at that address → compare the
/// returned account userId with the signed-in one. A different userId means a
/// different server instance and the address is rejected. (A dedicated server
/// fingerprint endpoint would need a contracts change; the userId match is the
/// current same-instance check — see ServerAddressStore.)
struct AddServerAddressSheet: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @StateObject private var oauthLogin = OAuthLoginCoordinator()
    @State private var addressValue = ""
    @State private var isWorking = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(String(localized: "Server address"), text: $addressValue)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                } header: {
                    Text(String(localized: "Server address"))
                } footer: {
                    Text(String(localized: "The address must point to the same server instance you are signed in to. You will be asked to sign in once to verify it."))
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .navigationTitle(String(localized: "Add Server Address"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel")) {
                        oauthLogin.cancel()
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isWorking ? String(localized: "Verifying…") : String(localized: "Add")) {
                        Task { await addAddress() }
                    }
                    .disabled(isWorking || addressValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .disabled(isWorking)
        }
    }

    private func addAddress() async {
        errorMessage = nil
        isWorking = true
        defer { isWorking = false }
        do {
            let url = try URL.agentsServer(from: addressValue)
            guard !appState.serverAddresses.contains(where: { $0.url == url }) else {
                errorMessage = String(localized: "This address is already in the list.")
                return
            }
            try await LocalNetworkAccess.prepare(for: url)
            let client = APIClient(serverURL: url)
            _ = try await client.health()
            let authConfig = try await client.authConfig()
            guard authConfig.oauthEnabled else {
                errorMessage = String(localized: "This server does not allow adding its address: OAuth sign-in is not enabled.")
                return
            }
            let token = try await oauthLogin.authenticate(serverURL: url)
            let profile = try await client.me(token: token.accessToken)
            guard let current = appState.me else {
                errorMessage = String(localized: "Sign out and in again, then retry.")
                return
            }
            guard profile.userId == current.userId else {
                errorMessage = String(localized: "This address belongs to a different server instance. Addresses in one list must point to the same instance.")
                return
            }
            appState.addServerAddress(url)
            dismiss()
        } catch {
            if !Task.isCancelled { errorMessage = error.localizedDescription }
        }
    }
}
