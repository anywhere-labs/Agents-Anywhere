import Foundation

/// Protocol 1.2 `DisplayEnvelope`: human-facing session content the Server stores but
/// never reads. `plain` carries the JSON object itself (normal mode); `sealed` carries
/// `base64url(nonce ‖ AES-256-GCM(directory key, …))` for the key named by `keyId`
/// (e2ee 1.0, "加密的存放内容").
nonisolated struct V2DisplayEnvelope: Codable, Hashable, Sendable {
    nonisolated enum Mode: String, Codable, Hashable, Sendable {
        case plain
        case sealed
        case unknown

        init(from decoder: Decoder) throws {
            let value = try decoder.singleValueContainer().decode(String.self)
            self = Self(rawValue: value) ?? .unknown
        }
    }

    let mode: Mode
    var keyId: String? = nil
    let payload: JSONValue
}
