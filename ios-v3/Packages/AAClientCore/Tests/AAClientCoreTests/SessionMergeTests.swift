import Foundation
import Testing

@testable import AAClientCore

/// Runs every case of the shared cross-client fixture `contracts/aa-v3/1.0/fixtures/session-merge.json`.
@Suite("Session merge (contract fixtures)")
struct SessionMergeTests {
    struct Fixture: Decodable {
        struct Case: Decodable {
            struct Event: Decodable {
                var source: String
                var result: DeviceSessionResult
            }

            struct Expected: Decodable {
                var sessionOrder: [String]
                var deviceStates: [String: DeviceListState]
                enum CodingKeys: String, CodingKey {
                    case sessionOrder = "session_order"
                    case deviceStates = "device_states"
                }
            }

            var name: String
            var initialCache: [String: SessionList]
            var localE2eeDevices: [String]
            var events: [Event]
            var expected: Expected

            enum CodingKeys: String, CodingKey {
                case name, events, expected
                case initialCache = "initial_cache"
                case localE2eeDevices = "local_e2ee_devices"
            }
        }

        var cases: [Case]
    }

    static func load() throws -> Fixture {
        // ios-v3/Packages/AAClientCore/Tests/AAClientCoreTests/<this file> → repository root.
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url.deleteLastPathComponent() }
        let file = url.appendingPathComponent("contracts/aa-v3/1.0/fixtures/session-merge.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: file))
    }

    @Test func allFixtureCases() throws {
        let fixture = try Self.load()
        #expect(fixture.cases.count >= 6)
        for testCase in fixture.cases {
            var merger = SessionMerger(cache: testCase.initialCache, localE2EE: Set(testCase.localE2eeDevices))
            for event in testCase.events {
                merger.apply(event.result, from: MergeSource(rawValue: event.source) ?? .controlPlane)
            }
            #expect(merger.sessions.map(\.id) == testCase.expected.sessionOrder, "\(testCase.name)")
            #expect(merger.states == testCase.expected.deviceStates, "\(testCase.name)")
        }
    }
}
