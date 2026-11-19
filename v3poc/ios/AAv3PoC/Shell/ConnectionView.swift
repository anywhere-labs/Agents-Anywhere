import SwiftUI

struct ConnectionView: View {
    let account: NativeAccount
    let reopen: Bool
    let onOpen: (OnlineWorkspace) -> Void

    @State private var loaded = false
    @State private var signedIn = false
    @State private var busy = false
    @State private var devices: [Workspace.Device] = []
    @State private var selected: Workspace.Device?
    @State private var error: LocalizedStringKey?
    @State private var server = ""
    @State private var email = ""
    @State private var password = ""
    @State private var invitation = ""
    @State private var keyMismatch = false
    @State private var confirmForget = false

    var body: some View {
        NavigationStack {
            Form {
                if !signedIn {
                    if loaded {
                        TextField("connection.server", text: $server)
                            .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        TextField("connection.email", text: $email)
                            .textContentType(.username).keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        SecureField("connection.password", text: $password).textContentType(.password)
                        Button("connection.sign_in") {
                            perform("connection.unavailable") {
                                try await account.signIn(address: server, email: email, password: password)
                                password = ""
                                signedIn = true
                                try await refresh(reopen: false)
                            }
                        }.disabled(server.isEmpty || email.isEmpty || password.isEmpty)
                    }
                } else if let selected {
                    Section(selected.name) {
                        TextField("connection.invite", text: $invitation)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button("connection.open") {
                            perform("connection.pair_failed") {
                                let link = invitation.trimmingCharacters(in: .whitespacesAndNewlines)
                                onOpen(try await account.open(device: selected, invitation: link.isEmpty ? nil : link))
                            }
                        }
                    }
                    Button("connection.devices") {
                        self.selected = nil
                        invitation = ""
                        error = nil
                        keyMismatch = false
                    }
                    if keyMismatch {
                        Button("connection.forget_pairing", role: .destructive) { confirmForget = true }
                            .confirmationDialog("connection.forget_pairing", isPresented: $confirmForget, titleVisibility: .visible) {
                                Button("connection.forget_pairing", role: .destructive) {
                                    perform("connection.pair_failed") {
                                        try await account.forgetPairing(device: selected)
                                        invitation = ""
                                    }
                                }
                            } message: {
                                Text("connection.forget_pairing_detail")
                            }
                    }
                } else {
                    if devices.isEmpty && !busy { Text("connection.no_devices") }
                    ForEach(devices) { device in
                        Button(device.name) {
                            selected = device
                            invitation = ""
                            error = nil
                        }
                    }
                    Button("connection.refresh") { perform("connection.unavailable") { try await refresh(reopen: false) } }
                    Button("connection.sign_out", role: .destructive) {
                        perform("connection.unavailable") {
                            defer { signedIn = false; devices = [] }
                            try await account.signOut()
                        }
                    }
                }
                if busy { ProgressView() }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .disabled(busy)
            .navigationTitle(title)
        }
        .task {
            guard !loaded else { return }
            await run("connection.unavailable") {
                defer { loaded = true }
                signedIn = try await account.restore()
                if signedIn { try await refresh(reopen: reopen) }
            }
        }
    }

    private var title: LocalizedStringKey {
        if !signedIn { return "connection.sign_in" }
        return selected == nil ? "connection.devices" : "connection.pair"
    }

    private func refresh(reopen: Bool) async throws {
        let result = try await account.devices()
        devices = result.known
        if reopen, let device = devices.first(where: { $0.id == result.recent }) {
            selected = device
            onOpen(try await account.open(device: device, invitation: nil))
        }
    }

    private func perform(_ fallback: LocalizedStringKey, operation: @escaping () async throws -> Void) {
        Task { await run(fallback, operation: operation) }
    }

    private func run(_ fallback: LocalizedStringKey, operation: () async throws -> Void) async {
        guard !busy else { return }
        busy = true
        error = nil
        keyMismatch = false
        defer { busy = false }
        do {
            try await operation()
        } catch is CancellationError {
            return
        } catch NativeAccountError.address {
            error = "connection.invalid_server"
        } catch NativeAccountError.http(401) {
            error = "connection.unauthorized"
        } catch ContentPairingError.targetMismatch {
            error = "connection.wrong_device"
        } catch DeviceContentError.identityMismatch {
            error = "connection.key_changed"
            keyMismatch = true
        } catch {
            self.error = fallback
        }
    }
}
