import CryptoKit
import Foundation

/// e2ee 1.0 的字节格式（contracts/e2ee/1.0/README.md，向量 vectors/aa-formats.json）：
/// 绑定标签、clientId、指纹、prologue、传输帧分片、展示信封、分段密文与输入摘要。
/// 原语全部来自 CryptoKit（经 `NoiseCrypto`）；这里只有字节拼接与编码。
nonisolated enum E2EEFormats {
    static let labelPrefix = "aa-e2ee/1.0"
    static let pairingProtocol = "Noise_XXpsk0_25519_AESGCM_SHA256"
    static let reconnectProtocol = "Noise_KK_25519_AESGCM_SHA256"

    static let frameContinue: UInt8 = 0x00
    static let frameFinal: UInt8 = 0x01
    static let frameRekey: UInt8 = 0x02
    /// 65535 - 16（tag）- 1（flag）。
    static let frameMaxBody = NoiseCrypto.maxMessageLen - NoiseCrypto.tagLen - 1
    static let channelMaxMessageBytes = 16 * 1024 * 1024
    static let rekeyIntervalFrames = 1 << 20
    static let rekeyInterval: TimeInterval = 60 * 60
    static let sealedSegmentBytes = 64 * 1024
    static let pairingURIPrefix = "aa-pair://"

    // MARK: 标识与绑定

    /// `aa-e2ee/1.0` 加上各字段，用 NUL 连接后的 UTF-8 字节。字段里不能有 NUL。
    static func label(_ fields: String...) throws -> Data {
        try label(fields)
    }

    static func label(_ fields: [String]) throws -> Data {
        guard !fields.contains(where: { $0.contains("\0") }) else {
            throw E2EEError(code: E2EEError.protocolError, message: "binding fields must not contain NUL")
        }
        return Data(([labelPrefix] + fields).joined(separator: "\0").utf8)
    }

    /// `cli_` + 小写 base32(SHA-256(label("client-id") ‖ 0x00 ‖ 公钥)) 的前 26 个字符。
    static func clientId(for identityPub: Data) -> String {
        let digest = NoiseCrypto.sha256(Data((labelPrefix + "\0client-id").utf8) + Data([0]) + identityPub)
        return "cli_" + String(base32Lower(digest).prefix(26))
    }

    /// 人工比对用：SHA-256(公钥) 的前 32 个十六进制字符，每 4 个一组。
    static func fingerprint(_ identityPub: Data) -> String {
        let hex = NoiseCrypto.sha256(identityPub).prefix(16).map { String(format: "%02x", $0) }.joined()
        var groups: [String] = []
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 4)
            groups.append(String(hex[index..<next]))
            index = next
        }
        return groups.joined(separator: " ")
    }

    static func pairingPrologue(deviceId: String, pairingId: String, clientId: String, ch: String) throws -> Data {
        try label("pair", deviceId, pairingId, clientId, ch)
    }

    static func connectPrologue(deviceId: String, clientId: String, ch: String) throws -> Data {
        try label("connect", deviceId, clientId, ch)
    }

    static func isChannelId(_ value: String) -> Bool {
        (1...64).contains(value.utf8.count) && value.utf8.allSatisfy { byte in
            (0x30...0x39).contains(byte) || (0x41...0x5a).contains(byte) || (0x61...0x7a).contains(byte) || byte == 0x5f || byte == 0x2d
        }
    }

    /// 每条通道一个新的 `ch`：断线后不恢复旧的会话密钥。
    static func newChannelId() -> String {
        "c_" + base64url(Data((0..<9).map { _ in UInt8.random(in: 0...255) }))
    }

    // MARK: 编码

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func fromBase64url(_ text: String) throws -> Data {
        guard text.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else {
            throw E2EEError(code: E2EEError.protocolError, message: "invalid base64url")
        }
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64) else {
            throw E2EEError(code: E2EEError.protocolError, message: "invalid base64url")
        }
        return data
    }

    private static func base32Lower(_ bytes: Data) -> String {
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz234567")
        var out = ""
        var buffer: UInt32 = 0
        var bits = 0
        for byte in bytes {
            buffer = (buffer << 8) | UInt32(byte)
            bits += 8
            while bits >= 5 {
                out.append(alphabet[Int((buffer >> UInt32(bits - 5)) & 31)])
                bits -= 5
            }
            buffer &= (1 << UInt32(bits)) - 1
        }
        if bits > 0 { out.append(alphabet[Int((buffer << UInt32(5 - bits)) & 31)]) }
        return out
    }

    // MARK: 帧

    /// 把一条通道消息切成传输明文 `flag ‖ body`，最后一片是 FINAL。
    static func fragment(_ message: Data) throws -> [Data] {
        guard message.count <= channelMaxMessageBytes else {
            throw E2EEError(code: E2EEError.tooLarge, message: "channel message too large")
        }
        var frames: [Data] = []
        var offset = message.startIndex
        repeat {
            let end = min(offset + frameMaxBody, message.endIndex)
            var frame = Data([end >= message.endIndex ? frameFinal : frameContinue])
            frame.append(message[offset..<end])
            frames.append(frame)
            offset = end
        } while offset < message.endIndex
        return frames
    }

    // MARK: 展示信封

    static func displayEnvelopeAD(deviceId: String, sessionId: String, slot: E2EEDisplaySlot, keyId: String) throws -> Data {
        try label("display", deviceId, sessionId, slot.rawValue, keyId)
    }

    /// `base64url(nonce12 ‖ AES-256-GCM(列表密钥, nonce, 明文, AD))`；nonce 默认随机生成。
    static func sealDisplayEnvelope(key: Data, ad: Data, plaintext: Data, nonce: Data? = nil) throws -> String {
        guard key.count == 32 else { throw E2EEError(code: E2EEError.protocolError, message: "directory key must be 32 bytes") }
        let gcmNonce = try nonce.map { try AES.GCM.Nonce(data: $0) } ?? AES.GCM.Nonce()
        let box = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), nonce: gcmNonce, authenticating: ad)
        guard let combined = box.combined else { throw E2EEError(code: E2EEError.protocolError, message: "nonce must be 12 bytes") }
        return base64url(combined)
    }

    static func openDisplayEnvelope(key: Data, ad: Data, payload: String) throws -> Data {
        let bytes = try fromBase64url(payload)
        guard key.count == 32, bytes.count >= 12 + NoiseCrypto.tagLen else {
            throw E2EEError(code: E2EEError.decryptFailed, message: "sealed payload too short")
        }
        do {
            let box = try AES.GCM.SealedBox(combined: bytes)
            return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: ad)
        } catch {
            throw E2EEError(code: E2EEError.decryptFailed, message: "display envelope failed to decrypt")
        }
    }

    // MARK: 分段密文（附件、分享）

    static func sealedSegmentAD(purpose: E2EESealedPurpose, objectId: String, index: Int, final: Bool) throws -> Data {
        try label(purpose.rawValue, objectId, String(index)) + Data([0, final ? 1 : 0])
    }

    /// 明文按 64 KiB 分段（空对象算一个空段），第 i 段 nonce = 4 字节 0 ‖ i 的 8 字节大端。
    static func sealSegments(purpose: E2EESealedPurpose, objectId: String, key: Data, plaintext: Data) throws -> [Data] {
        guard key.count == 32 else { throw E2EEError(code: E2EEError.protocolError, message: "object key must be 32 bytes") }
        let count = max(1, (plaintext.count + sealedSegmentBytes - 1) / sealedSegmentBytes)
        return try (0..<count).map { index in
            let start = plaintext.startIndex + index * sealedSegmentBytes
            let chunk = plaintext[start..<min(start + sealedSegmentBytes, plaintext.endIndex)]
            let ad = try sealedSegmentAD(purpose: purpose, objectId: objectId, index: index, final: index == count - 1)
            return try NoiseCrypto.encrypt(key: key, nonce: UInt64(index), ad: ad, plaintext: Data(chunk))
        }
    }

    /// `sealSegments` 的逆操作；篡改、换序、截断都会失败。
    static func openSegments(purpose: E2EESealedPurpose, objectId: String, key: Data, segments: [Data]) throws -> Data {
        guard !segments.isEmpty, key.count == 32 else { throw E2EEError(code: E2EEError.decryptFailed, message: "no segments") }
        var out = Data()
        for (index, segment) in segments.enumerated() {
            let ad = try sealedSegmentAD(purpose: purpose, objectId: objectId, index: index, final: index == segments.count - 1)
            do {
                out += try NoiseCrypto.decrypt(key: key, nonce: UInt64(index), ad: ad, ciphertext: segment)
            } catch {
                throw E2EEError(code: E2EEError.decryptFailed, message: "segment \(index) failed to decrypt")
            }
        }
        return out
    }

    // MARK: 加密附件

    static let sealedUploadHeader = "x-aa-sealed"
    static let sealedUploadValue = "segments-v1"
    /// 经通道读设备文件时每块最多这么多明文字节（`TunnelFileChunk`）。
    static let fileChunkMaxBytes = 8 * 1024 * 1024

    /// 加密一个附件：随机密钥，objectId 用明文 SHA-256（小写十六进制，加密时 Server 还没分配 fileId），
    /// 上传体是各段密文按顺序直接拼接。返回的密钥还没有 fileId，上传后再补上。
    static func sealAttachment(_ plaintext: Data) throws -> (ciphertext: Data, key: E2EESealedAttachmentKey) {
        let key = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        let sha256 = NoiseCrypto.sha256(plaintext).map { String(format: "%02x", $0) }.joined()
        let segments = try sealSegments(purpose: .attachment, objectId: sha256, key: key, plaintext: plaintext)
        return (segments.reduce(into: Data()) { $0.append($1) },
                E2EESealedAttachmentKey(fileId: "", key: base64url(key), size: plaintext.count, sha256: sha256))
    }

    /// `sealAttachment` 的逆操作（设备侧做的事；测试与诊断用）：按 64 KiB + 16 切段，解密后核对大小与摘要。
    static func openAttachment(_ ciphertext: Data, key: E2EESealedAttachmentKey) throws -> Data {
        let keyBytes = try fromBase64url(key.key)
        let stride = sealedSegmentBytes + NoiseCrypto.tagLen
        var segments: [Data] = []
        var offset = ciphertext.startIndex
        repeat {
            let end = min(offset + stride, ciphertext.endIndex)
            segments.append(Data(ciphertext[offset..<end]))
            offset = end
        } while offset < ciphertext.endIndex
        let plaintext = try openSegments(purpose: .attachment, objectId: key.sha256, key: keyBytes, segments: segments)
        guard plaintext.count == key.size,
              NoiseCrypto.sha256(plaintext).map({ String(format: "%02x", $0) }).joined() == key.sha256
        else { throw E2EEError(code: E2EEError.decryptFailed, message: "attachment size or digest mismatch") }
        return plaintext
    }

    // MARK: 输入摘要

    static func inputDigestKey(directoryKey: Data) throws -> Data {
        NoiseCrypto.hmacSHA256(key: directoryKey, data: try label("input-digest"))
    }

    /// `hmac-sha256:` + base64url(HMAC(HMAC(列表密钥, label("input-digest")), 请求体原始字节))。
    static func inputDigest(directoryKey: Data, body: Data) throws -> String {
        "hmac-sha256:" + base64url(NoiseCrypto.hmacSHA256(key: try inputDigestKey(directoryKey: directoryKey), data: body))
    }

    // MARK: 配对链接

    /// 解析二维码里的 `aa-pair://<base64url(PairingPayload)>`。
    static func parsePairingURI(_ text: String) throws -> E2EEPairingPayload {
        let uri = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard uri.hasPrefix(pairingURIPrefix) else {
            throw E2EEError(code: E2EEError.invalidPairingCode, message: "not an aa-pair:// link")
        }
        do {
            let json = try fromBase64url(String(uri.dropFirst(pairingURIPrefix.count)))
            let payload = try JSONDecoder().decode(E2EEPairingPayload.self, from: json)
            guard payload.v == 1,
                  try fromBase64url(payload.deviceIdentityPub).count == 32,
                  try fromBase64url(payload.psk).count == 32,
                  !payload.deviceId.isEmpty, !payload.pairingId.isEmpty
            else { throw E2EEError(code: E2EEError.invalidPairingCode, message: "malformed pairing payload") }
            return payload
        } catch let error as E2EEError where error.code == E2EEError.invalidPairingCode {
            throw error
        } catch {
            throw E2EEError(code: E2EEError.invalidPairingCode, message: "malformed pairing payload")
        }
    }
}

/// 收集分片；FINAL 帧凑齐一条消息时返回。
nonisolated struct E2EEReassembler {
    enum Output: Equatable {
        case message(Data)
        case rekey
    }

    private var parts = Data()
    private var inMessage = false

    mutating func push(_ plaintext: Data) throws -> Output? {
        guard let flag = plaintext.first else {
            throw E2EEError(code: E2EEError.protocolError, message: "empty transport frame")
        }
        let body = plaintext.dropFirst()
        switch flag {
        case E2EEFormats.frameRekey:
            guard body.isEmpty, !inMessage else {
                throw E2EEError(code: E2EEError.protocolError, message: "rekey frame inside a message")
            }
            return .rekey
        case E2EEFormats.frameContinue, E2EEFormats.frameFinal:
            guard parts.count + body.count <= E2EEFormats.channelMaxMessageBytes else {
                throw E2EEError(code: E2EEError.tooLarge, message: "channel message too large")
            }
            parts.append(body)
            inMessage = true
            guard flag == E2EEFormats.frameFinal else { return nil }
            defer { parts = Data(); inMessage = false }
            return .message(parts)
        default:
            throw E2EEError(code: E2EEError.protocolError, message: "unknown frame flag \(flag)")
        }
    }
}

nonisolated enum E2EEDisplaySlot: String, Sendable {
    case device, user
}

nonisolated enum E2EESealedPurpose: String, Sendable {
    case attachment, share
}
