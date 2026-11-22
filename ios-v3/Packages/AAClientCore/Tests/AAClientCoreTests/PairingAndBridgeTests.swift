import Foundation
import Testing

@testable import AAClientCore

@Suite("Pairing and trust")
struct PairingTests {
    static func payload(expires: Date = Date().addingTimeInterval(300), extra: [String: Any] = [:]) -> String {
        let device = E2EKeyPair.generate()
        var object: [String: Any] = [
            "v": 1, "instance_id": "dev_1", "device_pub": device.publicKey, "pairing_id": "pair_12345678",
            "psk": Base64URL.encode(Data(repeating: 7, count: 32)), "expires_at": ISO8601.format(expires),
        ]
        object.merge(extra) { _, new in new }
        let data = try! JSONSerialization.data(withJSONObject: object)
        return "aa-pair://v1/" + Base64URL.encode(data)
    }

    @Test func parsesValidURI() throws {
        let payload = try PairingPayload.parse(Self.payload())
        #expect(payload.instanceID == "dev_1")
        #expect(payload.pairingID == "pair_12345678")
        #expect(Base64URL.isKey32(payload.devicePub))
        // Round trip.
        #expect(try PairingPayload.parse(payload.uri()) == payload)
    }

    @Test func refusesBadURIs() {
        func code(_ uri: String) -> PairingErrorCode? {
            do {
                _ = try PairingPayload.parse(uri)
                return nil
            } catch let error as PairingError {
                return error.code
            } catch {
                return nil
            }
        }
        #expect(code("https://example.com") == .invalidPairingURI)
        #expect(code("aa-pair://v1/!!!") == .invalidPairingURI)
        #expect(code(Self.payload(extra: ["server_hint": "x"])) == .invalidPairingURI)
        #expect(code(Self.payload(extra: ["v": 2])) == .invalidPairingURI)
        #expect(code(Self.payload(extra: ["psk": "short"])) == .invalidPairingURI)
        #expect(code(Self.payload(extra: ["pairing_id": "short"])) == .invalidPairingURI)
        #expect(code(Self.payload(expires: Date().addingTimeInterval(-1))) == .pairingExpired)
    }

    @Test func trustStoreKeepsRecordsPerAccount() throws {
        let store = MemorySecretStore()
        let trust = TrustStore(store: store, accountID: "u1")
        let payload = try PairingPayload.parse(Self.payload())
        try trust.save(DeviceTrustRecord(payload: payload, deviceNameHint: "Mac"))
        #expect(trust.record(for: "dev_1")?.requireE2EE == true)
        #expect(trust.record(for: "dev_1")?.lockBadge == "green")
        #expect(TrustStore(store: store, accountID: "u2").record(for: "dev_1") == nil)
        try trust.remove("dev_1")
        #expect(trust.record(for: "dev_1") == nil)
    }

    @Test func clientIdentityIsStable() throws {
        let identity = ClientIdentityStore(store: MemorySecretStore())
        let first = try identity.privateKey()
        #expect(try identity.privateKey() == first)
        #expect(Base64URL.isKey32(try identity.publicKey()))
    }

    @Test func fingerprintFormat() {
        let fingerprint = KeyFingerprint.format(Base64URL.encode(Data(repeating: 1, count: 32)))
        #expect(fingerprint.split(separator: " ").count == 8)
        #expect(fingerprint.allSatisfy { $0 == " " || $0.isHexDigit })
    }
}

@Suite("Render bridge")
struct BridgeTests {
    @Test func queuesUntilReadyThenBatches() throws {
        var outbox = BridgeOutbox()
        outbox.enqueue(BridgeOut.theme(dark: true, insets: .init(top: 100, bottom: 80, left: 0, right: 0), reduceMotion: false))
        #expect(outbox.drainScript() == nil)
        outbox.markReady()
        outbox.enqueue(BridgeOut.locale("zh-Hans"))
        let drained = outbox.drainScript()
        let script = try #require(drained)
        #expect(script.hasPrefix("window.aa && window.aa.receive("))
        let json = String(script.dropFirst("window.aa && window.aa.receive(".count).dropLast())
        let value = try JSONValue(json: Data(json.utf8))
        #expect(value["type"]?.stringValue == "batch")
        #expect(value["v"]?.intValue == 2)
        let messages = try #require(value["messages"]?.arrayValue)
        #expect(messages.map { $0["type"]?.stringValue } == ["theme", "locale"])
        #expect(messages[0]["insets"]?["top"]?.intValue == 100)
        #expect(messages[1]["locale"]?.stringValue == "zh-CN")
        #expect(outbox.drainScript() == nil)

        outbox.enqueue(BridgeOut.scroll(toBottom: true))
        let singleDrained = outbox.drainScript()
        let single = try #require(singleDrained)
        #expect(single.contains("\"type\":\"scroll\""))
    }

    @Test func terminalFramesAreRenamed() {
        let frame = BridgeOut.terminalFrame(terminalID: "t1", frame: ["type": "output", "data": "aGk="])
        #expect(frame["type"]?.stringValue == "term.output")
        #expect(frame["terminal_id"]?.stringValue == "t1")
        #expect(frame["data"]?.stringValue == "aGk=")
        let closed = BridgeOut.terminalClosed(terminalID: "t1", fatal: true)
        #expect(closed["type"]?.stringValue == "term.closed")
        #expect(closed["fatal"]?.boolValue == true)
        let view = BridgeOut.viewTerminal(deviceID: "d", terminalID: "t1", attachMode: "control")
        #expect(view["attach_mode"]?.stringValue == "control")
        let key = BridgeOut.terminalKey("up", ctrl: true)
        #expect(key["ctrl"]?.boolValue == true)
        #expect(key["alt"] == nil)
    }

    @Test func parsesIncomingMessages() {
        #expect(BridgeIn.parse(["v": 2, "type": "ready", "version": "1.0", "protocol": "aa.render/2", "capabilities": ["conversation", "terminal"]] as [String: Any])
            == .ready(version: "1.0", protocol: "aa.render/2", capabilities: ["conversation", "terminal"]))
        #expect(BridgeIn.parse(#"{"v":2,"type":"load_older","session_id":"s","before_seq":12}"#) == .loadOlder(sessionID: "s", beforeSeq: 12))
        #expect(BridgeIn.parse(["v": 2, "type": "answer", "session_id": "s", "request_id": "r", "option_id": "o"] as [String: Any])
            == .answer(sessionID: "s", requestID: "r", optionID: "o"))
        #expect(BridgeIn.parse(["v": 2, "type": "file.read", "request_id": "q", "path": "/a", "max_bytes": 10] as [String: Any])
            == .fileRead(requestID: "q", path: "/a", maxBytes: 10))
        #expect(BridgeIn.parse(["v": 2, "type": "scroll_state", "at_bottom": false, "distance": 320.5] as [String: Any])
            == .scrollState(atBottom: false, distance: 320.5))
        #expect(BridgeIn.parse(["v": 2, "type": "term.input", "terminal_id": "t", "data": "YQ=="] as [String: Any])
            == .terminal(type: "input", fields: ["terminal_id": "t", "data": "YQ=="]))
        #expect(BridgeIn.parse(["v": 2, "type": "nope"] as [String: Any]) == .unknown("nope"))
        #expect(BridgeIn.parse(["v": 2, "type": "answer"] as [String: Any]) == nil)
    }
}
