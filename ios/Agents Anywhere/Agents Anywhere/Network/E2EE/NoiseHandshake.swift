import Foundation

/// 握手结束后传输用的两个 CipherState。
nonisolated struct NoiseTransportPair {
    let send: NoiseCipherState
    let receive: NoiseCipherState
    let handshakeHash: Data
    /// 握手里认证过的对端身份公钥。
    let remoteStatic: Data?
}

/// HandshakeState（Noise 规范 §5.3）。授权判断在上层（Client Trust）。
nonisolated final class NoiseHandshake {
    let pattern: NoiseHandshakePattern
    let initiator: Bool
    private let symmetric: NoiseSymmetricState
    private let s: NoiseKeyPair?
    private var e: NoiseKeyPair?
    private var rs: Data?
    private var re: Data?
    private var psks: [Data]
    private let pskMode: Bool
    private var index = 0
    private var failed = false
    private var result: NoiseTransportPair?

    /// - Parameter e: 只用于测试向量：固定的临时密钥。
    init(
        protocolName: String, initiator: Bool, prologue: Data = Data(),
        s: NoiseKeyPair? = nil, e: NoiseKeyPair? = nil, rs: Data? = nil, re: Data? = nil, psks: [Data] = []
    ) throws {
        pattern = try NoiseHandshakePattern.parse(protocolName: protocolName)
        self.initiator = initiator
        symmetric = try NoiseSymmetricState(protocolName: protocolName)
        self.s = s
        self.e = e
        self.rs = rs
        self.re = re
        self.psks = psks
        pskMode = pattern.messages.contains { $0.contains(.psk) }
        let pskCount = pattern.messages.reduce(0) { $0 + $1.filter { $0 == .psk }.count }
        guard psks.count == pskCount else { throw NoiseError.invalid("\(pattern.name) needs \(pskCount) psk(s), got \(psks.count)") }
        guard psks.allSatisfy({ $0.count == 32 }) else { throw NoiseError.invalid("psk must be 32 bytes") }
        for key in [rs, re].compactMap({ $0 }) where key.count != NoiseCrypto.dhLen {
            throw NoiseError.invalid("public key must be 32 bytes")
        }
        symmetric.mixHash(prologue)
        try mixPreMessage(pattern.initiatorPre, local: initiator)
        try mixPreMessage(pattern.responderPre, local: !initiator)
    }

    var isComplete: Bool { index >= pattern.messages.count }
    var isMyTurn: Bool { index % 2 == (initiator ? 0 : 1) }
    var handshakeHash: Data { symmetric.handshakeHash }
    var remoteStatic: Data? { rs }

    /// 握手结束后取得传输用的 CipherState；只能取一次。
    func takeTransport() throws -> NoiseTransportPair {
        guard let out = result else { throw NoiseError.invalid("handshake not complete") }
        result = nil
        return out
    }

    func writeMessage(_ payload: Data = Data()) throws -> Data {
        let tokens = try nextTokens(writing: true)
        return try guarded {
            var out = Data()
            for token in tokens {
                switch token {
                case .e:
                    let ephemeral = e ?? NoiseCrypto.generateKeyPair()
                    e = ephemeral
                    out += ephemeral.publicKey
                    symmetric.mixHash(ephemeral.publicKey)
                    if pskMode { try symmetric.mixKey(ephemeral.publicKey) }
                case .s:
                    out += try symmetric.encryptAndHash(try requireS().publicKey)
                case .psk:
                    try symmetric.mixKeyAndHash(psks.removeFirst())
                default:
                    try symmetric.mixKey(try dh(for: token))
                }
            }
            out += try symmetric.encryptAndHash(payload)
            guard out.count <= NoiseCrypto.maxMessageLen else { throw NoiseError.invalid("handshake message too long") }
            try advance()
            return out
        }
    }

    func readMessage(_ message: Data) throws -> Data {
        let tokens = try nextTokens(writing: false)
        return try guarded {
            guard message.count <= NoiseCrypto.maxMessageLen else { throw NoiseError.invalid("handshake message too long") }
            let bytes = Data(message)
            var offset = 0
            func take(_ length: Int) throws -> Data {
                guard offset + length <= bytes.count else { throw NoiseError.invalid("handshake message truncated") }
                defer { offset += length }
                return bytes.subdata(in: offset..<(offset + length))
            }
            for token in tokens {
                switch token {
                case .e:
                    guard re == nil else { throw NoiseError.invalid("remote ephemeral already set") }
                    let remote = try take(NoiseCrypto.dhLen)
                    re = remote
                    symmetric.mixHash(remote)
                    if pskMode { try symmetric.mixKey(remote) }
                case .s:
                    guard rs == nil else { throw NoiseError.invalid("remote static already set") }
                    let length = symmetric.cipher.hasKey ? NoiseCrypto.dhLen + NoiseCrypto.tagLen : NoiseCrypto.dhLen
                    rs = try symmetric.decryptAndHash(try take(length))
                case .psk:
                    try symmetric.mixKeyAndHash(psks.removeFirst())
                default:
                    try symmetric.mixKey(try dh(for: token))
                }
            }
            let payload = try symmetric.decryptAndHash(bytes.subdata(in: offset..<bytes.count))
            try advance()
            return payload
        }
    }

    private func guarded<T>(_ body: () throws -> T) throws -> T {
        do {
            return try body()
        } catch {
            failed = true
            throw error
        }
    }

    private func nextTokens(writing: Bool) throws -> [NoiseToken] {
        guard !failed else { throw NoiseError.invalid("handshake already failed") }
        guard index < pattern.messages.count else { throw NoiseError.invalid("handshake already complete") }
        guard writing == isMyTurn else { throw NoiseError.invalid(writing ? "not our turn to write" : "not our turn to read") }
        return pattern.messages[index]
    }

    private func advance() throws {
        index += 1
        guard index >= pattern.messages.count else { return }
        let hash = symmetric.handshakeHash
        let (c1, c2) = try symmetric.split()
        result = NoiseTransportPair(
            send: initiator ? c1 : c2, receive: initiator ? c2 : c1, handshakeHash: hash, remoteStatic: rs
        )
    }

    private func mixPreMessage(_ tokens: [NoiseToken], local: Bool) throws {
        for token in tokens {
            let key: Data?
            switch token {
            case .s: key = local ? try requireS().publicKey : rs
            case .e: key = local ? e?.publicKey : re
            default: throw NoiseError.invalid("unexpected pre-message token")
            }
            guard let key else { throw NoiseError.invalid("pre-message needs a key") }
            symmetric.mixHash(key)
        }
    }

    private func dh(for token: NoiseToken) throws -> Data {
        let pair: (NoiseKeyPair?, Data?)
        switch token {
        case .ee: pair = (e, re)
        case .ss: pair = (s, rs)
        case .es: pair = initiator ? (e, rs) : (s, re)
        case .se: pair = initiator ? (s, re) : (e, rs)
        default: throw NoiseError.invalid("not a DH token")
        }
        guard let local = pair.0, let remote = pair.1 else { throw NoiseError.invalid("missing key for DH") }
        let shared = try local.dh(remote)
        // 低阶点得到全零共享密钥：三端一律拒绝。
        guard shared.count == NoiseCrypto.dhLen, shared.contains(where: { $0 != 0 }) else {
            throw NoiseError.invalid("invalid DH result")
        }
        return shared
    }

    private func requireS() throws -> NoiseKeyPair {
        guard let s else { throw NoiseError.invalid("local static key required") }
        return s
    }
}
