import Foundation

/// CipherState（Noise 规范 §5.1）。
nonisolated final class NoiseCipherState {
    private var key: Data?
    /// 下一条消息要用的计数器。
    private(set) var nonce: UInt64 = 0

    init(key: Data? = nil) throws {
        if let key { try initializeKey(key) }
    }

    func initializeKey(_ key: Data) throws {
        guard key.count == NoiseCrypto.keyLen else { throw NoiseError.invalid("key must be 32 bytes") }
        self.key = key
        nonce = 0
    }

    var hasKey: Bool { key != nil }

    func setNonce(_ value: UInt64) throws {
        guard value != NoiseCrypto.maxNonce else { throw NoiseError.invalid("nonce out of range") }
        nonce = value
    }

    func encrypt(ad: Data, plaintext: Data) throws -> Data {
        guard let key else { return plaintext }
        guard nonce != NoiseCrypto.maxNonce else { throw NoiseError.invalid("nonce exhausted") }
        let out = try NoiseCrypto.encrypt(key: key, nonce: nonce, ad: ad, plaintext: plaintext)
        nonce += 1
        return out
    }

    func decrypt(ad: Data, ciphertext: Data) throws -> Data {
        guard let key else { return ciphertext }
        guard nonce != NoiseCrypto.maxNonce else { throw NoiseError.invalid("nonce exhausted") }
        guard ciphertext.count >= NoiseCrypto.tagLen else { throw NoiseError.invalid("ciphertext shorter than tag") }
        // 认证失败时计数器不前进。
        let out = try NoiseCrypto.decrypt(key: key, nonce: nonce, ad: ad, ciphertext: ciphertext)
        nonce += 1
        return out
    }

    /// REKEY：k = ENCRYPT(k, 2^64-1, "", zeros)[0:32]；计数器不变。
    func rekey() throws {
        guard let key else { throw NoiseError.invalid("rekey without key") }
        let out = try NoiseCrypto.encrypt(key: key, nonce: NoiseCrypto.maxNonce, ad: Data(), plaintext: Data(count: NoiseCrypto.keyLen))
        self.key = out.prefix(NoiseCrypto.keyLen)
    }

    func destroy() {
        key = nil
    }
}

/// SymmetricState（Noise 规范 §5.2）。
nonisolated final class NoiseSymmetricState {
    let cipher: NoiseCipherState
    private var ck: Data
    private var h: Data

    init(protocolName: String) throws {
        cipher = try NoiseCipherState()
        let name = Data(protocolName.utf8)
        if name.count <= NoiseCrypto.hashLen {
            h = name + Data(count: NoiseCrypto.hashLen - name.count)
        } else {
            h = NoiseCrypto.sha256(name)
        }
        ck = h
    }

    var handshakeHash: Data { h }

    func mixKey(_ ikm: Data) throws {
        let out = hkdf(ikm, outputs: 2)
        ck = out[0]
        try cipher.initializeKey(out[1])
    }

    func mixHash(_ data: Data) {
        h = NoiseCrypto.sha256(h + data)
    }

    func mixKeyAndHash(_ ikm: Data) throws {
        let out = hkdf(ikm, outputs: 3)
        ck = out[0]
        mixHash(out[1])
        try cipher.initializeKey(out[2])
    }

    func encryptAndHash(_ plaintext: Data) throws -> Data {
        let ciphertext = try cipher.encrypt(ad: h, plaintext: plaintext)
        mixHash(ciphertext)
        return ciphertext
    }

    func decryptAndHash(_ ciphertext: Data) throws -> Data {
        let plaintext = try cipher.decrypt(ad: h, ciphertext: ciphertext)
        mixHash(ciphertext)
        return plaintext
    }

    func split() throws -> (NoiseCipherState, NoiseCipherState) {
        let out = hkdf(Data(), outputs: 2)
        ck = Data(count: NoiseCrypto.hashLen)
        cipher.destroy()
        return (try NoiseCipherState(key: out[0]), try NoiseCipherState(key: out[1]))
    }

    private func hkdf(_ ikm: Data, outputs: Int) -> [Data] {
        let tempKey = NoiseCrypto.hmacSHA256(key: ck, data: ikm)
        let out1 = NoiseCrypto.hmacSHA256(key: tempKey, data: Data([0x01]))
        let out2 = NoiseCrypto.hmacSHA256(key: tempKey, data: out1 + Data([0x02]))
        if outputs == 2 { return [out1, out2] }
        let out3 = NoiseCrypto.hmacSHA256(key: tempKey, data: out2 + Data([0x03]))
        return [out1, out2, out3]
    }
}
