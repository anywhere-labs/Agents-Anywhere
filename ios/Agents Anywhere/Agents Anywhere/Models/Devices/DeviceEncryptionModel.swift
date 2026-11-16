import Foundation
import Observation

/// 设备详情里的「端到端加密」状态。
@MainActor @Observable
final class DeviceEncryptionModel {
    private(set) var status: E2EEDeviceEncryptionStatus?
    private(set) var loadError: String?

    /// Server 没开加密、本机没记过要求加密、也没配对过时，这一节不显示。
    var isVisible: Bool {
        guard let status else { return false }
        return status.requiresEncryption || status.record != nil
    }

    func load(service: V2E2EEService, deviceId: String) async {
        do {
            status = try await service.encryptionStatus(for: deviceId)
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }
}

/// 加密配对页：读二维码或粘贴的 `aa-pair://` 链接 → 显示设备指纹 → 配对。
@MainActor @Observable
final class E2EEPairingModel {
    /// 打开这个页面的设备；二维码属于别的设备时提醒。nil 表示不限定。
    let expectedDeviceId: String?
    let serverURL: URL?
    var link = ""
    private(set) var payload: E2EEPairingPayload?
    private(set) var parseError: String?
    private(set) var isPairing = false
    private(set) var paired: E2EEDeviceTrust?
    private(set) var error: String?
    private let now: () -> Date

    init(expectedDeviceId: String?, serverURL: URL?, now: @escaping () -> Date = Date.init) {
        self.expectedDeviceId = expectedDeviceId
        self.serverURL = serverURL
        self.now = now
    }

    /// 扫到或粘贴的内容。
    func read(_ text: String) {
        error = nil
        do {
            payload = try E2EEFormats.parsePairingURI(text)
            parseError = nil
        } catch {
            payload = nil
            parseError = error.localizedDescription
        }
    }

    func reset() {
        payload = nil
        parseError = nil
        error = nil
        link = ""
    }

    var fingerprint: String { payload?.deviceFingerprint ?? "" }

    var isForAnotherDevice: Bool {
        guard let payload, let expectedDeviceId else { return false }
        return payload.deviceId != expectedDeviceId
    }

    var isForAnotherServer: Bool {
        guard let payload, let serverURL, let codeURL = URL(string: payload.serverUrl) else { return false }
        return codeURL.normalizedV2ServerURL().absoluteString.lowercased() != serverURL.normalizedV2ServerURL().absoluteString.lowercased()
    }

    var isExpired: Bool {
        guard let payload else { return false }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let expiry = ISO8601DateFormatter().date(from: payload.expiresAt) ?? fractional.date(from: payload.expiresAt)
        else { return false }
        return expiry <= now()
    }

    var canPair: Bool { payload != nil && !isPairing && !isForAnotherDevice && !isExpired && paired == nil }

    func pair(service: V2E2EEService) async {
        guard canPair, let payload else { return }
        isPairing = true
        error = nil
        defer { isPairing = false }
        do {
            paired = try await service.pair(payload)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
