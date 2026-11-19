import Foundation
import Synchronization
import Testing
@testable import ClientCore

/// contracts/e2ee/1.0/vectors/aa-formats.json：Noise 之外的字节格式，逐项比对。
nonisolated enum E2EEVectors {
    static func formats() throws -> [String: Any] { try NoiseVectors.load("aa-formats.json") }
    static func hex(_ text: String) -> Data { NoiseVectors.hex(text) }
    static func hex(_ data: Data) -> String { NoiseVectors.hex(data) }

    /// 分段密文向量的明文：第 i 字节是 (i*31+7) & 0xff。
    static func pattern(_ length: Int) -> Data { Data((0..<length).map { UInt8(($0 * 31 + 7) & 0xff) }) }
}

@Test func e2eeIdentityVectors() throws {
    let identities = try E2EEVectors.formats()["identities"] as! [[String: String]]
    #expect(!identities.isEmpty)
    for vector in identities {
        let pub = E2EEVectors.hex(vector["identityPub"]!)
        #expect(E2EEFormats.base64url(pub) == vector["identityPubB64"])
        #expect(try E2EEFormats.fromBase64url(vector["identityPubB64"]!) == pub)
        #expect(E2EEFormats.clientId(for: pub) == vector["clientId"])
        #expect(E2EEFormats.fingerprint(pub) == vector["fingerprint"])
    }
}

@Test func e2eePrologueVectors() throws {
    let prologues = try E2EEVectors.formats()["prologues"] as! [[String: Any]]
    #expect(prologues.count == 2)
    for vector in prologues {
        let fields = vector["fields"] as! [String]
        let bytes: Data = vector["kind"] as! String == "pair"
            ? try E2EEFormats.pairingPrologue(deviceId: fields[0], pairingId: fields[1], clientId: fields[2], ch: fields[3])
            : try E2EEFormats.connectPrologue(deviceId: fields[0], clientId: fields[1], ch: fields[2])
        #expect(E2EEVectors.hex(bytes) == vector["bytes"] as? String)
    }
    #expect(throws: E2EEError.self) { try E2EEFormats.label("a\0b") }
}

@Test func e2eeDisplayEnvelopeVectors() throws {
    let envelopes = try E2EEVectors.formats()["displayEnvelopes"] as! [[String: String]]
    #expect(envelopes.count == 2)
    for vector in envelopes {
        let key = E2EEVectors.hex(vector["directoryKey"]!)
        let ad = try E2EEFormats.displayEnvelopeAD(deviceId: vector["deviceId"]!, sessionId: vector["sessionId"]!,
                                                   slot: E2EEDisplaySlot(rawValue: vector["slot"]!)!, keyId: vector["keyId"]!)
        #expect(E2EEVectors.hex(ad) == vector["ad"])
        let plaintext = Data(vector["plaintext"]!.utf8)
        let sealed = try E2EEFormats.sealDisplayEnvelope(key: key, ad: ad, plaintext: plaintext, nonce: E2EEVectors.hex(vector["nonce"]!))
        #expect(sealed == vector["payload"])
        #expect(try E2EEFormats.openDisplayEnvelope(key: key, ad: ad, payload: vector["payload"]!) == plaintext)
        // AD 绑定了所在的行：换一个会话或槽位就解不开。
        let otherRow = try E2EEFormats.displayEnvelopeAD(deviceId: vector["deviceId"]!, sessionId: "sess_other",
                                                         slot: E2EEDisplaySlot(rawValue: vector["slot"]!)!, keyId: vector["keyId"]!)
        #expect(throws: E2EEError.self) { try E2EEFormats.openDisplayEnvelope(key: key, ad: otherRow, payload: vector["payload"]!) }
        // 随机 nonce 的密封也能被打开。
        let random = try E2EEFormats.sealDisplayEnvelope(key: key, ad: ad, plaintext: plaintext)
        #expect(random != sealed)
        #expect(try E2EEFormats.openDisplayEnvelope(key: key, ad: ad, payload: random) == plaintext)
    }
}

@Test func e2eeSealedSegmentVectors() throws {
    let objects = try E2EEVectors.formats()["sealedObjects"] as! [[String: Any]]
    #expect(objects.count >= 3)
    for vector in objects {
        let purpose = E2EESealedPurpose(rawValue: vector["purpose"] as! String)!
        let objectId = vector["objectId"] as! String
        let key = E2EEVectors.hex(vector["key"] as! String)
        #expect(E2EEFormats.base64url(key) == vector["keyB64"] as? String)
        let plaintext = E2EEVectors.pattern(vector["plaintextLength"] as! Int)
        let segments = try E2EEFormats.sealSegments(purpose: purpose, objectId: objectId, key: key, plaintext: plaintext)
        let expected = vector["segments"] as! [[String: Any]]
        #expect(segments.count == expected.count, "\(objectId)")
        for (segment, want) in zip(segments, expected) {
            let index = want["index"] as! Int
            let ad = try E2EEFormats.sealedSegmentAD(purpose: purpose, objectId: objectId, index: index, final: want["final"] as! Bool)
            #expect(E2EEVectors.hex(ad) == want["ad"] as? String)
            #expect(segment.count == want["ciphertextLength"] as? Int)
            #expect(E2EEVectors.hex(NoiseCrypto.sha256(segment)) == want["ciphertextSha256"] as? String)
            if let ciphertext = want["ciphertext"] as? String { #expect(E2EEVectors.hex(segment) == ciphertext) }
        }
        #expect(try E2EEFormats.openSegments(purpose: purpose, objectId: objectId, key: key, segments: segments) == plaintext)
        if segments.count > 1 {
            // 截断：少了最后一段，倒数第二段的 AD 里 final = 0，解不开。
            #expect(throws: E2EEError.self) {
                try E2EEFormats.openSegments(purpose: purpose, objectId: objectId, key: key, segments: Array(segments.dropLast()))
            }
            #expect(throws: E2EEError.self) {
                try E2EEFormats.openSegments(purpose: purpose, objectId: objectId, key: key, segments: segments.reversed())
            }
        }
    }
}

@Test func e2eeInputDigestVectors() throws {
    let digests = try E2EEVectors.formats()["inputDigests"] as! [[String: String]]
    #expect(digests.count == 2)
    for vector in digests {
        let key = E2EEVectors.hex(vector["directoryKey"]!)
        #expect(E2EEVectors.hex(try E2EEFormats.inputDigestKey(directoryKey: key)) == vector["digestKey"])
        #expect(try E2EEFormats.inputDigest(directoryKey: key, body: Data(vector["body"]!.utf8)) == vector["inputDigest"])
    }
}

@Test func e2eeFramingVectors() throws {
    let framing = try E2EEVectors.formats()["framing"] as! [[String: Any]]
    #expect(framing.count >= 5)
    for vector in framing {
        let message = E2EEVectors.pattern(vector["messageLength"] as! Int)
        let frames = try E2EEFormats.fragment(message)
        let expected = vector["frames"] as! [[String: Int]]
        #expect(frames.map { Int($0.first!) } == expected.map { $0["flag"]! })
        #expect(frames.map { $0.count - 1 } == expected.map { $0["bodyLength"]! })
        var reassembler = E2EEReassembler()
        var result: E2EEReassembler.Output?
        for frame in frames { result = try reassembler.push(frame) }
        #expect(result == .message(message))
    }
    var reassembler = E2EEReassembler()
    #expect(try reassembler.push(Data([E2EEFormats.frameRekey])) == .rekey)
    _ = try reassembler.push(Data([E2EEFormats.frameContinue, 1]))
    #expect(throws: E2EEError.self) { try reassembler.push(Data([E2EEFormats.frameRekey])) }
    #expect(throws: E2EEError.self) { try E2EEFormats.fragment(Data(count: E2EEFormats.channelMaxMessageBytes + 1)) }
}

@Test func e2eePairingURIVector() throws {
    let vector = try E2EEVectors.formats()["pairingUri"] as! [String: Any]
    let payload = try E2EEFormats.parsePairingURI(vector["uri"] as! String)
    let expected = try JSONDecoder().decode(E2EEPairingPayload.self, from: Data((vector["json"] as! String).utf8))
    #expect(payload == expected)
    #expect(payload.deviceId == "dev_vector")
    #expect(payload.requiresEncryption)
    #expect(payload.deviceFingerprint == E2EEFormats.fingerprint(try E2EEFormats.fromBase64url(payload.deviceIdentityPub)))
    for bad in ["https://example.com", "aa-pair://not-base64!", "aa-pair://" + E2EEFormats.base64url(Data("{}".utf8))] {
        #expect(throws: E2EEError(code: E2EEError.invalidPairingCode)) { try E2EEFormats.parsePairingURI(bad) }
    }
}

@Test func e2eeTransportSessionChecksNonceAndRekeys() throws {
    // 用 NN 拿到一对传输 CipherState，只测传输层。
    let a = try NoiseHandshake(protocolName: "Noise_NN_25519_AESGCM_SHA256", initiator: true)
    let b = try NoiseHandshake(protocolName: "Noise_NN_25519_AESGCM_SHA256", initiator: false)
    _ = try b.readMessage(try a.writeMessage())
    _ = try a.readMessage(try b.writeMessage())
    var clock = Date(timeIntervalSince1970: 0)
    let sender = E2EETransportSession(pair: try a.takeTransport(), now: { clock }, rekeyFrames: 3)
    let receiver = E2EETransportSession(pair: try b.takeTransport(), now: { clock })

    var items: [E2EEChannelItem] = []
    for index in 0..<5 { items += try sender.seal(Data("{\"i\":\(index)}".utf8)) }
    // 5 条消息、每 3 帧 rekey 一次：0 1 2 R 3 4。
    #expect(items.count == 6)
    #expect(items.map(\.n) == Array(0..<6))
    #expect(sender.sentRekeys == 1)

    // 计数器不连续时直接拒绝，不尝试解密，接收计数器不变。
    #expect(throws: E2EEError.self) { try receiver.open(items[1]) }
    #expect(receiver.receiveNonce == 0)
    var messages: [Data] = []
    for item in items { if let message = try receiver.open(item) { messages.append(message) } }
    #expect(messages.count == 5)
    #expect(receiver.receivedRekeys == 1)

    // 满 1 小时也 rekey。
    clock = clock.addingTimeInterval(E2EEFormats.rekeyInterval)
    let late = try sender.seal(Data("{}".utf8))
    #expect(late.count == 2)
    for item in late { _ = try receiver.open(item) }
    #expect(receiver.receivedRekeys == 2)

    // 篡改密文：解密失败，计数器不前进。
    let next = try sender.seal(Data("{\"x\":1}".utf8))[0]
    var raw = try E2EEFormats.fromBase64url(next.ct)
    raw[raw.startIndex] ^= 0x01
    let before = receiver.receiveNonce
    #expect(throws: E2EEError.self) { try receiver.open(E2EEChannelItem(n: next.n, ct: E2EEFormats.base64url(raw))) }
    #expect(receiver.receiveNonce == before)
    #expect(try receiver.open(next) == Data("{\"x\":1}".utf8))
}

@Test func e2eeServerConfigIsLenient() throws {
    func decode(_ json: String) throws -> E2EEServerConfig? {
        struct Wrapper: Decodable { var e2ee: E2EEServerConfig? = nil }
        return try JSONDecoder().decode(Wrapper.self, from: Data(json.utf8)).e2ee
    }
    #expect(try decode("{}") == nil)
    #expect(try decode(#"{"e2ee":{"mode":"required","web":true,"preview":false}}"#)?.mode == .required)
    #expect(try decode(#"{"e2ee":{"mode":"off"}}"#)?.mode == .off)
    #expect(try decode(#"{"e2ee":"garbage"}"#)?.mode == .off)
    #expect(try decode(#"{"e2ee":null}"#) == nil)
}

@Test func e2eeContentPathsPreserveAPIAndQuery() {
    #expect(v2APIPath("/api/v3/e2ee/commands") == "/api/v3/e2ee/commands")
    #expect(E2EEChannelHTTPTransport.path("/sessions/s1/events", query: [URLQueryItem(name: "after", value: "seq:1")])
            == "/api/v2/sessions/s1/events?after=seq:1")
}
