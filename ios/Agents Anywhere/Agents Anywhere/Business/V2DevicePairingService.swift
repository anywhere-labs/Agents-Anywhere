import Foundation

struct V2DevicePairingService {
    let connectorAPI: any V2ConnectorAPIProtocol

    /// Creates durable connector credentials on the server for a new pairing attempt.
    func createDevice(name: String) async throws -> V2ConnectorCreateResponse {
        let normalizedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedName.isEmpty else { throw V2BusinessError.emptyDeviceName }
        return try await connectorAPI.createConnector(
            request: V2ConnectorCreateRequest(name: normalizedName)
        )
    }

    /// Claims the one-time code and delivers the prepared credentials to the target connector.
    func claimPairing(
        code: String,
        name: String,
        serverURL: URL,
        connectorId: V2ConnectorID,
        connectorToken: String
    ) async throws -> V2Connector {
        let normalizedCode = code.filter(\.isNumber)
        guard normalizedCode.count == 6 else { throw V2BusinessError.invalidPairingCode }
        let response = try await connectorAPI.claimPairing(
            request: V2PairingClaimRequest(
                code: normalizedCode,
                name: name,
                serverUrl: serverURL.absoluteString,
                connectorId: connectorId,
                connectorToken: connectorToken
            )
        )
        guard response.status == "claimed", let connector = response.connector else {
            throw V2BusinessError.pairingNotClaimed
        }
        return connector
    }

    /// Reads the server's current effective presence for the paired connector.
    func connector(connectorId: V2ConnectorID) async throws -> V2Connector {
        try await connectorAPI.connector(connectorId: connectorId).connector
    }

    /// Requests fresh runtime discovery after the connector becomes online.
    func discoverRuntimes(connectorId: V2ConnectorID) async throws -> [V2DeviceRuntime] {
        try await connectorAPI.discoverRuntimes(connectorId: connectorId).runtimes
    }
}
