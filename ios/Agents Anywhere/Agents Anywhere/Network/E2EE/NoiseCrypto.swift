import CryptoKit
import Foundation

/// Noise 套件 25519_AESGCM_SHA256 的原语（S8 结论，见 contracts/e2ee/1.0/README.md）。
/// 原语全部来自 CryptoKit，不在本仓库实现。
nonisolated enum NoiseCrypto {
    static let dhLen = 32
    static let hashLen = 32
    static let keyLen = 32
    static let tagLen = 16
    static let maxMessageLen = 65535
    /// 2^64 - 1，保留给 rekey。
    static let maxNonce = UInt64.max

    static func generateKeyPair() -> X25519KeyPair {
        X25519KeyPair(privateKey: Curve25519.KeyAgreement.PrivateKey())
    }

    static func encrypt(key: Data, nonce: UInt64, ad: Data, plaintext: Data) throws -> Data {
        let box = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), nonce: gcmNonce(nonce), authenticating: ad)
        return box.ciphertext + box.tag
    }

    static func decrypt(key: Data, nonce: UInt64, ad: Data, ciphertext: Data) throws -> Data {
        guard ciphertext.count >= tagLen else { throw NoiseError.decryptFailed }
        let body = ciphertext.prefix(ciphertext.count - tagLen)
        let tag = ciphertext.suffix(tagLen)
        do {
            let box = try AES.GCM.SealedBox(nonce: gcmNonce(nonce), ciphertext: body, tag: tag)
            return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: ad)
        } catch {
            throw NoiseError.decryptFailed
        }
    }

    static func sha256(_ data: Data) -> Data {
        Data(SHA256.hash(data: data))
    }

    static func hmacSHA256(key: Data, data: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }

    /// AESGCM 的 nonce：4 字节 0 + 8 字节大端计数器（Noise 规范 §12.4）。
    private static func gcmNonce(_ n: UInt64) throws -> AES.GCM.Nonce {
        var bytes = Data(count: 4)
        withUnsafeBytes(of: n.bigEndian) { bytes.append(contentsOf: $0) }
        return try AES.GCM.Nonce(data: bytes)
    }
}

/// 一个 X25519 密钥对。
nonisolated protocol NoiseKeyPair {
    var publicKey: Data { get }
    func dh(_ remotePublicKey: Data) throws -> Data
}

nonisolated struct X25519KeyPair: NoiseKeyPair {
    let privateKey: Curve25519.KeyAgreement.PrivateKey

    init(privateKey: Curve25519.KeyAgreement.PrivateKey) {
        self.privateKey = privateKey
    }

    init(secret: Data) throws {
        guard secret.count == NoiseCrypto.dhLen else { throw NoiseError.invalid("private key must be 32 bytes") }
        privateKey = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secret)
    }

    var publicKey: Data { privateKey.publicKey.rawRepresentation }

    func dh(_ remotePublicKey: Data) throws -> Data {
        guard remotePublicKey.count == NoiseCrypto.dhLen else { throw NoiseError.invalid("public key must be 32 bytes") }
        do {
            let remote = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: remotePublicKey)
            let shared = try privateKey.sharedSecretFromKeyAgreement(with: remote)
            return shared.withUnsafeBytes { Data($0) }
        } catch {
            throw NoiseError.invalid("invalid DH result")
        }
    }
}

nonisolated enum NoiseError: Error, Equatable {
    /// 认证标签不符：密文被篡改、密钥不对，或 psk 不一致。
    case decryptFailed
    case invalid(String)
}
