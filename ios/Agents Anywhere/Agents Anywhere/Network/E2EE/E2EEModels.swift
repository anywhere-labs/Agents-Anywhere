import Foundation

/// 通道失败或被关闭。`code` 是 AA 错误码（`e2ee_not_paired`、`pairing_expired`、`device_pin_mismatch`、
/// `e2ee_protocol_error`……），界面文案来自 `RuntimeErrorText`。
nonisolated struct E2EEError: LocalizedError, Equatable, Sendable {
    static let notPaired = "e2ee_not_paired"
    static let pairingExpired = "pairing_expired"
    static let pinMismatch = "device_pin_mismatch"
    static let protocolError = "e2ee_protocol_error"
    static let handshakeFailed = "e2ee_handshake_failed"
    static let required = "e2ee_required"
    static let tooLarge = "too_large"
    static let closed = "closed"
    static let connectorOffline = "connector_offline"
    /// 本机记过「必须加密」，Server 却让走明文。
    static let downgradeRefused = "e2ee_downgrade_refused"
    /// 以下只在客户端本地出现。
    static let decryptFailed = "e2ee_decrypt_failed"
    static let invalidPairingCode = "e2ee_invalid_pairing_code"
    static let unsupported = "e2ee_unsupported"

    let code: String
    let message: String
    /// true 只在设备经认证通道内发来 `close` 时成立。Server 转来的 `ClientTunnelEnd.code`、隧道断开、
    /// 本地校验失败都是 false：Server 可以伪造这些，它们绝不能改变信任记录或放松策略。
    let fromDevice: Bool

    init(code: String, message: String = "", fromDevice: Bool = false) {
        self.code = code
        self.message = message.isEmpty ? code : message
        self.fromDevice = fromDevice
    }

    var errorDescription: String? {
        switch code {
        case Self.invalidPairingCode: String(localized: "e2ee.error.invalidPairingCode")
        case Self.decryptFailed: String(localized: "e2ee.error.decryptFailed")
        default: RuntimeErrorText.text(code: code, fallback: String(localized: "e2ee.error.generic"))
        }
    }

    static func == (lhs: E2EEError, rhs: E2EEError) -> Bool { lhs.code == rhs.code }
}

/// 设备二维码里的内容：`aa-pair://<base64url(json)>`。
nonisolated struct E2EEPairingPayload: Codable, Hashable, Sendable {
    let v: Int
    let deviceId: String
    let deviceIdentityPub: String
    let pairingId: String
    let psk: String
    let serverUrl: String
    let e2eeMode: String
    let expiresAt: String

    var requiresEncryption: Bool { e2eeMode == E2EEMode.required.rawValue }
    var deviceFingerprint: String { (try? E2EEFormats.fromBase64url(deviceIdentityPub)).map(E2EEFormats.fingerprint) ?? "" }
}

nonisolated enum E2EEMode: String, Codable, Sendable {
    case off, required
}

/// `GET /api/v2/auth/config` 里的 `e2ee`。旧 Server 没有这个字段，按 off；字段格式不对时也不让登录失败。
nonisolated struct E2EEServerConfig: Decodable, Hashable, Sendable {
    let mode: E2EEMode
    let web: JSONValue?
    let preview: JSONValue?

    static let off = E2EEServerConfig(mode: .off, web: nil, preview: nil)

    init(mode: E2EEMode, web: JSONValue?, preview: JSONValue?) {
        self.mode = mode
        self.web = web
        self.preview = preview
    }

    init(from decoder: Decoder) throws {
        let value = (try? JSONValue(from: decoder)) ?? .null
        mode = value["mode"]?.stringValue == E2EEMode.required.rawValue ? .required : .off
        web = value["web"]
        preview = value["preview"]
    }
}

/// 设备经通道交给客户端的列表密钥。
nonisolated struct E2EEDirectoryKeyGrant: Codable, Hashable, Sendable {
    let deviceId: String
    let keyId: String
    let epoch: Int
    let key: String
}

nonisolated struct E2EEChannelReady: Hashable, Sendable {
    let deviceId: String
    let clientId: String
    let directoryKeyId: String
    let directoryKeyEpoch: Int
}

/// `pair.committed` 带来的授权。
nonisolated struct E2EEPairingResult: Hashable, Sendable {
    let deviceId: String
    let clientId: String
    let devicePub: Data
    let grantedAt: String
    let directoryKey: E2EEDirectoryKeyGrant
}

/// 隧道上的路由头；Server 只读它和 `n`。
nonisolated struct E2EETunnelRoute: Codable, Hashable, Sendable {
    let deviceId: String
    let clientId: String
    let ch: String
}

/// 一帧 `{n, ct}`：握手阶段 `n = step`、`ct` 是 HandshakeEnvelope；之后 `n` 是 Noise nonce。
nonisolated struct E2EEChannelItem: Hashable, Sendable {
    let n: UInt64
    let ct: String
}

nonisolated struct E2EEHandshakeEnvelope: Codable, Hashable, Sendable {
    enum Pattern: String, Codable, Sendable { case xxpsk0 = "XXpsk0", kk = "KK" }

    let pattern: Pattern
    let pairingId: String?
    let step: Int
    let message: String

    func encoded() throws -> E2EEChannelItem {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return E2EEChannelItem(n: UInt64(step), ct: E2EEFormats.base64url(try encoder.encode(self)))
    }

    static func decode(_ item: E2EEChannelItem, expectedStep: Int) throws -> E2EEHandshakeEnvelope {
        guard let json = try? E2EEFormats.fromBase64url(item.ct),
              let envelope = try? JSONDecoder().decode(E2EEHandshakeEnvelope.self, from: json)
        else { throw E2EEError(code: E2EEError.protocolError, message: "handshake frame is not a HandshakeEnvelope") }
        guard item.n == UInt64(expectedStep), envelope.step == expectedStep else {
            throw E2EEError(code: E2EEError.protocolError, message: "unexpected handshake frame")
        }
        return envelope
    }
}

/// 通道内 `response` 的结果；`body` 是原样的 JSON 字节（null 时为 `null`）。
nonisolated struct E2EETunnelResponse: Sendable {
    let status: Int
    let body: Data
}

/// `POST /api/v3/e2ee/commands`。
nonisolated struct E2EECommandRegistration: Codable, Hashable, Sendable {
    let commandId: String
    let deviceId: String
    let inputDigest: String
}

nonisolated struct E2EECommandRegistrationResponse: Decodable, Hashable, Sendable {
    let duplicate: Bool

    private enum CodingKeys: String, CodingKey { case duplicate }

    init(duplicate: Bool) { self.duplicate = duplicate }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        duplicate = (try? container.decodeIfPresent(Bool.self, forKey: .duplicate)) ?? false
    }
}
