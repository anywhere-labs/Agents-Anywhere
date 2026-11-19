import Foundation
@testable import ClientCore

struct LegacyE2EEChannelProvider: E2EEChannelProvider {
    let tunnel: any E2EETunnel

    func pair(_ payload: E2EEPairingPayload, trust: ClientTrustStore, label: String) async throws -> any E2EEDeviceChannel {
        try await ClientSecureChannel.pair(
            payload, identity: trust.identity(), tunnel: tunnel, trust: trust, label: label, platform: "ios"
        ).channel
    }

    func connect(_ record: E2EEDeviceTrust, trust: ClientTrustStore) async throws -> any E2EEDeviceChannel {
        guard let key = record.devicePubBytes else { throw E2EEError(code: E2EEError.pinMismatch) }
        return try await ClientSecureChannel.connect(
            deviceId: record.deviceId, devicePub: key, identity: trust.identity(), tunnel: tunnel, trust: trust
        )
    }
}
