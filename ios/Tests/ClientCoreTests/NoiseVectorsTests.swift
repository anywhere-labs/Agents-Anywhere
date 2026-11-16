import Foundation
import Testing
@testable import ClientCore

/// 跑 contracts/e2ee/1.0/vectors 下三端共用的 Noise 测试向量。
nonisolated enum NoiseVectors {
    static func load(_ name: String) throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("contracts/e2ee/1.0/vectors/\(name)")
        return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    }

    static func hex(_ string: String) -> Data {
        var data = Data(capacity: string.count / 2)
        var index = string.startIndex
        while index < string.endIndex {
            let next = string.index(index, offsetBy: 2)
            data.append(UInt8(string[index..<next], radix: 16)!)
            index = next
        }
        return data
    }

    static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    static func party(_ vector: [String: Any], _ prefix: String) throws -> NoiseHandshake {
        func opt(_ name: String) -> String? { vector["\(prefix)_\(name)"] as? String }
        let psks = (vector["\(prefix)_psks"] as? [String] ?? []).map(hex)
        return try NoiseHandshake(
            protocolName: vector["protocol_name"] as! String,
            initiator: prefix == "init",
            prologue: hex(opt("prologue") ?? ""),
            s: try opt("static").map { try X25519KeyPair(secret: hex($0)) },
            e: try opt("ephemeral").map { try X25519KeyPair(secret: hex($0)) },
            rs: opt("remote_static").map(hex),
            psks: psks
        )
    }

    static func run(_ vector: [String: Any]) throws {
        let name = vector["protocol_name"] as! String
        let initiator = try party(vector, "init")
        let responder = try party(vector, "resp")
        let handshakeCount = initiator.pattern.messages.count
        var transport: [String: NoiseTransportPair] = [:]
        for (index, message) in (vector["messages"] as! [[String: Any]]).enumerated() {
            let sender = message["sender"] as? String
                ?? ((initiator.pattern.oneWay || index % 2 == 0) ? "initiator" : "responder")
            let payload = hex(message["payload"] as! String)
            let expected = message["ciphertext"] as! String
            if index < handshakeCount {
                let (tx, rx) = sender == "initiator" ? (initiator, responder) : (responder, initiator)
                let ciphertext = try tx.writeMessage(payload)
                #expect(hex(ciphertext) == expected, "\(name) message \(index)")
                #expect(try rx.readMessage(ciphertext) == payload)
                if index == handshakeCount - 1 {
                    transport = ["initiator": try initiator.takeTransport(), "responder": try responder.takeTransport()]
                    #expect(transport["initiator"]!.handshakeHash == transport["responder"]!.handshakeHash)
                    if let hash = vector["handshake_hash"] as? String {
                        #expect(hex(transport["initiator"]!.handshakeHash) == hash, "\(name) handshake hash")
                    }
                }
                continue
            }
            let tx = transport[sender]!
            let rx = transport[sender == "initiator" ? "responder" : "initiator"]!
            if message["rekey_before"] as? Bool == true {
                try tx.send.rekey()
                try rx.receive.rekey()
            }
            let ciphertext = try tx.send.encrypt(ad: Data(), plaintext: payload)
            #expect(hex(ciphertext) == expected, "\(name) transport \(index)")
            #expect(try rx.receive.decrypt(ad: Data(), ciphertext: ciphertext) == payload)
        }
    }

    /// 返回读失败的消息序号；没有失败返回 nil。
    static func runNegative(_ negative: [String: Any], bases: [String: [String: Any]]) throws -> Int? {
        var vector = bases[negative["base"] as! String]!
        for (key, value) in negative["override"] as? [String: Any] ?? [:] { vector[key] = value }
        var messages = vector["messages"] as! [[String: Any]]
        if let tamper = negative["tamper"] as? [String: Int] {
            var raw = hex(messages[tamper["message"]!]["ciphertext"] as! String)
            raw[tamper["byte"]!] ^= 0x01
            messages[tamper["message"]!]["ciphertext"] = hex(raw)
        }
        let replay = (negative["replay"] as? [String: Int])?["message"]
        let initiator = try party(vector, "init")
        let responder = try party(vector, "resp")
        let handshakeCount = vector["handshake_messages"] as! Int
        var transport: [String: NoiseTransportPair] = [:]
        for (index, message) in messages.enumerated() {
            let sender = message["sender"] as! String
            let ciphertext = hex(message["ciphertext"] as! String)
            do {
                if index < handshakeCount {
                    let (tx, rx) = sender == "initiator" ? (initiator, responder) : (responder, initiator)
                    _ = try tx.writeMessage(hex(message["payload"] as! String))
                    _ = try rx.readMessage(ciphertext)
                    if index == handshakeCount - 1 {
                        transport = ["initiator": try initiator.takeTransport(), "responder": try responder.takeTransport()]
                    }
                } else {
                    let rx = transport[sender == "initiator" ? "responder" : "initiator"]!
                    if message["rekey_before"] as? Bool == true {
                        try transport[sender]!.send.rekey()
                        try rx.receive.rekey()
                    }
                    _ = try rx.receive.decrypt(ad: Data(), ciphertext: ciphertext)
                    if replay == index { _ = try rx.receive.decrypt(ad: Data(), ciphertext: ciphertext) }
                }
            } catch {
                return index
            }
        }
        return nil
    }
}

@Test func noiseOfficialVectors() throws {
    let vectors = try NoiseVectors.load("noise-official.json")["vectors"] as! [[String: Any]]
    #expect(vectors.count > 50)
    for vector in vectors { try NoiseVectors.run(vector) }
}

@Test func noiseAAVectors() throws {
    let document = try NoiseVectors.load("aa-noise.json")
    let vectors = document["vectors"] as! [[String: Any]]
    var bases: [String: [String: Any]] = [:]
    for vector in vectors {
        try NoiseVectors.run(vector)
        bases[vector["name"] as! String] = vector
    }
    let negatives = document["negative"] as! [[String: Any]]
    #expect(negatives.count >= 5)
    for negative in negatives {
        #expect(try NoiseVectors.runNegative(negative, bases: bases) == negative["fail_at"] as? Int, "\(negative["name"]!)")
    }
}
