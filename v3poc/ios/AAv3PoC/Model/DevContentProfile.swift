import Foundation

/// App-private account and workspace configuration for the development build.
struct DevContentProfile: Decodable {
    let serverUrl: URL
    let accessToken: String
    let pairingUri: String?
    let workspace: Workspace

    func sessionsClient() -> SessionsClient? {
        guard workspace.devices.count == 1, let device = workspace.devices.first else { return nil }
        let pairing = ContentPairing(
            server: serverUrl, accountID: workspace.account.email, deviceID: device.id,
            invitation: pairingUri, accessToken: { accessToken }
        )
        return MeshSessionsClient(device: device, connect: pairing.connect)
    }

    static func read() -> DevContentProfile? {
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        guard let data = try? Data(contentsOf: directory.appending(component: "content-profile.json")) else { return nil }
        return try? JSONDecoder().decode(DevContentProfile.self, from: data)
    }
}
