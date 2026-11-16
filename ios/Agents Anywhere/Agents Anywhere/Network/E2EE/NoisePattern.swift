import Foundation

/// 握手模式（Noise 规范 §7）。AA 只用 XXpsk0 与 KK；其他基本模式只为跑官方测试向量。
nonisolated enum NoiseToken: Equatable {
    case e, s, ee, es, se, ss, psk
}

nonisolated struct NoiseHandshakePattern {
    let name: String
    let initiatorPre: [NoiseToken]
    let responderPre: [NoiseToken]
    let messages: [[NoiseToken]]
    let oneWay: Bool

    static let suite = "25519_AESGCM_SHA256"

    private static let base: [String: (pre: ([NoiseToken], [NoiseToken]), messages: [[NoiseToken]])] = [
        "N": (([], [.s]), [[.e, .es]]),
        "K": (([.s], [.s]), [[.e, .es, .ss]]),
        "X": (([], [.s]), [[.e, .es, .s, .ss]]),
        "NN": (([], []), [[.e], [.e, .ee]]),
        "NK": (([], [.s]), [[.e, .es], [.e, .ee]]),
        "NX": (([], []), [[.e], [.e, .ee, .s, .es]]),
        "XN": (([], []), [[.e], [.e, .ee], [.s, .se]]),
        "XK": (([], [.s]), [[.e, .es], [.e, .ee], [.s, .se]]),
        "XX": (([], []), [[.e], [.e, .ee, .s, .es], [.s, .se]]),
        "KN": (([.s], []), [[.e], [.e, .ee, .se]]),
        "KK": (([.s], [.s]), [[.e, .es, .ss], [.e, .ee, .se]]),
        "KX": (([.s], []), [[.e], [.e, .ee, .se, .s, .es]]),
        "IN": (([], []), [[.e, .s], [.e, .ee, .se]]),
        "IK": (([], [.s]), [[.e, .es, .s, .ss], [.e, .ee, .se]]),
        "IX": (([], []), [[.e, .s], [.e, .ee, .se, .s, .es]]),
    ]

    /// 解析 `XXpsk0`、`KK`、`NNpsk0+psk2` 这样的模式名。
    static func parse(_ name: String) throws -> NoiseHandshakePattern {
        let baseName = String(name.prefix { "NKXI".contains($0) })
        guard (1...2).contains(baseName.count), let spec = base[baseName] else {
            throw NoiseError.invalid("unsupported handshake pattern \(name)")
        }
        var messages = spec.messages
        let rest = name.dropFirst(baseName.count)
        if !rest.isEmpty {
            for modifier in rest.split(separator: "+", omittingEmptySubsequences: false) {
                guard modifier.hasPrefix("psk"), modifier.count == 4, let index = Int(modifier.dropFirst(3)) else {
                    throw NoiseError.invalid("unsupported handshake pattern \(name)")
                }
                if index == 0 {
                    messages[0].insert(.psk, at: 0)
                } else if index <= messages.count {
                    messages[index - 1].append(.psk)
                } else {
                    throw NoiseError.invalid("\(modifier) is out of range for \(baseName)")
                }
            }
        }
        return NoiseHandshakePattern(
            name: name, initiatorPre: spec.pre.0, responderPre: spec.pre.1,
            messages: messages, oneWay: baseName.count == 1
        )
    }

    /// 只接受 `Noise_<pattern>_25519_AESGCM_SHA256`。
    static func parse(protocolName full: String) throws -> NoiseHandshakePattern {
        let prefix = "Noise_"
        let suffix = "_\(suite)"
        guard full.hasPrefix(prefix), full.hasSuffix(suffix), full.count > prefix.count + suffix.count else {
            throw NoiseError.invalid("unsupported protocol \(full); only \(suite) is implemented")
        }
        return try parse(String(full.dropFirst(prefix.count).dropLast(suffix.count)))
    }
}
