// Out-of-band pairing with encrypted devices (`aa-pair://v1/<base64url(json)>`) and the local trust records that
// pin them. Rules: `contracts/aa-v3/1.0/pairing.schema.json`, `docs/v3/e2ee-admission-proposal.md`.
//
// - The device key comes only from the QR code; server hints (`e2e_public_key_hint`, `mode_hint`) never create or
//   change trust.
// - A trust record is written BEFORE the first pairing tunnel opens, so nothing in between can talk plaintext to the
//   device, and is rolled back if pairing fails.
// - A different key for a pinned device is refused (`device_pub_mismatch`); re-pairing needs the user to forget the
//   device first. There is no "trust the new key" button.

import CryptoKit
import Foundation

public enum PairingErrorCode: String, Sendable, Codable {
    case invalidPairingURI = "invalid_pairing_uri"
    case pairingExpired = "pairing_expired"
    case pairingUsed = "pairing_used"
    case e2eHandshakeFailed = "e2e_handshake_failed"
    case devicePubMismatch = "device_pub_mismatch"
    case e2eRequiredLocally = "e2e_required_locally"
    case e2eNotPaired = "e2e_not_paired"
    case tunnelRevoked = "tunnel_revoked"
    case deviceOffline = "device_offline"
}

public struct PairingError: Error, Sendable, Equatable, LocalizedError {
    public let code: PairingErrorCode
    public let message: String

    public init(_ code: PairingErrorCode, _ message: String) {
        self.code = code
        self.message = message
    }

    public var errorDescription: String? { message }
}

public struct PairingPayload: Codable, Sendable, Hashable {
    public var v: Int
    public var instanceID: String
    public var devicePub: String
    public var pairingID: String
    public var psk: String
    public var expiresAt: String

    enum CodingKeys: String, CodingKey {
        case v, psk
        case instanceID = "instance_id"
        case devicePub = "device_pub"
        case pairingID = "pairing_id"
        case expiresAt = "expires_at"
    }

    static let prefix = "aa-pair://v1/"
    private static let allowedKeys: Set<String> = ["v", "instance_id", "device_pub", "pairing_id", "psk", "expires_at"]

    /// Parse and strictly validate a pairing URI (wrong version, extra fields, malformed keys and expired links are
    /// refused).
    public static func parse(_ raw: String, now: Date = Date()) throws -> PairingPayload {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix(prefix) else {
            throw PairingError(.invalidPairingURI, "配对链接必须以 aa-pair://v1/ 开头")
        }
        let encoded = String(trimmed.dropFirst(prefix.count))
        guard !encoded.isEmpty, encoded.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }),
              let data = Base64URL.decode(encoded),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            throw PairingError(.invalidPairingURI, "配对链接内容无法解析")
        }
        if let extra = object.keys.first(where: { !allowedKeys.contains($0) }) {
            throw PairingError(.invalidPairingURI, "配对内容含有未知字段 \(extra)")
        }
        guard (object["v"] as? NSNumber)?.intValue == 1 else {
            throw PairingError(.invalidPairingURI, "不支持的配对版本")
        }
        guard let instanceID = object["instance_id"] as? String, (1...128).contains(instanceID.count) else {
            throw PairingError(.invalidPairingURI, "配对内容中的设备 id 无效")
        }
        guard let devicePub = object["device_pub"] as? String, Base64URL.isKey32(devicePub) else {
            throw PairingError(.invalidPairingURI, "配对内容中的设备公钥无效")
        }
        guard let pairingID = object["pairing_id"] as? String, (8...128).contains(pairingID.count) else {
            throw PairingError(.invalidPairingURI, "配对 id 无效")
        }
        guard let psk = object["psk"] as? String, Base64URL.isKey32(psk) else {
            throw PairingError(.invalidPairingURI, "配对密钥无效")
        }
        guard let expiresAt = object["expires_at"] as? String, let expiry = ISO8601.parse(expiresAt) else {
            throw PairingError(.invalidPairingURI, "配对链接缺少有效的过期时间")
        }
        guard expiry > now else {
            throw PairingError(.pairingExpired, "配对二维码已过期，请在工作设备上重新生成")
        }
        return PairingPayload(v: 1, instanceID: instanceID, devicePub: devicePub, pairingID: pairingID, psk: psk, expiresAt: expiresAt)
    }

    public func uri() throws -> String {
        let data = try JSONEncoder().encode(self)
        return Self.prefix + Base64URL.encode(data)
    }
}

/// `ClientDeviceTrustRecord`: persisted before the first pairing tunnel; the server can never clear or relax it.
public struct DeviceTrustRecord: Codable, Sendable, Hashable {
    public var deviceID: String
    public var devicePub: String
    public var requireE2EE: Bool
    /// `verified_app` (green lock) for this app.
    public var trustTier: String
    public var pairedAt: String
    public var deviceNameHint: String?
    /// False until the IKpsk2 handshake was accepted; a record that never completed is rolled back.
    public var confirmed: Bool

    enum CodingKeys: String, CodingKey {
        case confirmed
        case deviceID = "device_id"
        case devicePub = "device_pub"
        case requireE2EE = "require_e2ee"
        case trustTier = "trust_tier"
        case pairedAt = "paired_at"
        case deviceNameHint = "device_name_hint"
    }

    public init(payload: PairingPayload, deviceNameHint: String? = nil, now: Date = Date()) {
        deviceID = payload.instanceID
        devicePub = payload.devicePub
        requireE2EE = true
        trustTier = "verified_app"
        pairedAt = ISO8601.format(now)
        self.deviceNameHint = deviceNameHint
        confirmed = false
    }

    /// Native apps are independently distributed: green lock.
    public var lockBadge: String { trustTier == "verified_app" ? "green" : "grey" }
}

/// Trust records of one account, kept in the secret store as one JSON map.
public final class TrustStore: @unchecked Sendable {
    private let store: any SecretStore
    private let key: String
    private let lock = NSLock()

    public init(store: any SecretStore, accountID: String) {
        self.store = store
        self.key = "device_trust.\(accountID)"
    }

    public func all() -> [String: DeviceTrustRecord] {
        lock.withLock { ((try? store.value([String: DeviceTrustRecord].self, for: key)) ?? nil) ?? [:] }
    }

    public func record(for deviceID: String) -> DeviceTrustRecord? {
        all()[deviceID]
    }

    public func save(_ record: DeviceTrustRecord) throws {
        try lock.withLock {
            var map = ((try? store.value([String: DeviceTrustRecord].self, for: key)) ?? nil) ?? [:]
            map[record.deviceID] = record
            try store.setValue(map, for: key)
        }
    }

    public func remove(_ deviceID: String) throws {
        try lock.withLock {
            var map = ((try? store.value([String: DeviceTrustRecord].self, for: key)) ?? nil) ?? [:]
            map.removeValue(forKey: deviceID)
            try store.setValue(map, for: key)
        }
    }
}

public enum KeyFingerprint {
    /// SHA-256 of the raw key, first 16 bytes as grouped upper-case hex (same as the Web client).
    public static func format(_ publicKeyB64URL: String) -> String {
        guard let bytes = Base64URL.decode(publicKeyB64URL) else { return "—" }
        let digest = SHA256.hash(data: bytes)
        let hex = digest.prefix(16).map { String(format: "%02X", $0) }.joined()
        return stride(from: 0, to: hex.count, by: 4).map { offset -> String in
            let start = hex.index(hex.startIndex, offsetBy: offset)
            let end = hex.index(start, offsetBy: 4, limitedBy: hex.endIndex) ?? hex.endIndex
            return String(hex[start..<end])
        }.joined(separator: " ")
    }
}

public enum Base64URL {
    public static func decode(_ value: String) -> Data? {
        var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        return Data(base64Encoded: base64)
    }

    public static func encode(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// 32 raw bytes as unpadded base64url (43 characters).
    public static func isKey32(_ value: String) -> Bool {
        value.count == 43 && value.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
            && decode(value)?.count == 32
    }
}

public enum ISO8601 {
    public static func parse(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: value)
    }

    public static func format(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
