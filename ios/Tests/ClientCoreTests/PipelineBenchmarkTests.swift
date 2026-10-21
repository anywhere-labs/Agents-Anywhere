import Foundation
import Testing
@testable import ClientCore

/// Synthetic streaming load: a 1000-item session receiving 300 token batches
/// for one growing reply. Prints per-phase totals; it asserts only a loose
/// ceiling so timing noise cannot fail CI.
@Suite @MainActor struct PipelineBenchmarkTests {
    @Test func streamingPipelineBenchmark() async throws {
        let itemCount = 1000, eventCount = 300
        let base = String(repeating: "The quick brown fox jumps over the lazy dog. ", count: 180) // ~8k chars
        let items = try (1...itemCount).map { try itemObject(id: "item-\($0)", order: $0, seq: $0, text: $0 == itemCount ? base : "Row \($0)") }
        var projection = V2SessionProjection(snapshot: try snapshot(items: items), maximumItems: itemCount)
        let repository = repository(transport: TestHTTPTransport())
        let session = repository.session(id: "session")
        let presentation = SessionTimelinePresentation()
        func observation() -> V2SessionObservation {
            V2SessionObservation(sessionId: "session", data: projection.data, connection: .connected, error: nil)
        }
        session.update(observation(), network: V2NetworkStatus())
        presentation.presentOpening(projection.data.items, pendingMessages: [])
        presentation.flush(now: 0)

        let payloads: [Data] = try (0..<eventCount).map { index in
            var object = try fixtureObject("event")
            object["type"] = "timeline.item_updated"; object["sequence"] = itemCount + 1 + index
            object["cursor"] = "seq:\(itemCount + 1 + index)"; object["eventId"] = "evt-\(index)"; object["sessionId"] = "session"
            object["payload"] = ["item": try itemObject(id: "item-\(itemCount)", order: itemCount, revision: index + 2,
                seq: itemCount + 1 + index, text: base + String(repeating: "more tokens ", count: index + 1))]
            return try JSONSerialization.data(withJSONObject: object)
        }

        let clock = ContinuousClock()
        var decode = Duration.zero, apply = Duration.zero, model = Duration.zero, present = Duration.zero
        let decoder = JSONDecoder()
        for (index, data) in payloads.enumerated() {
            var start = clock.now
            let event = try decoder.decode(V2SessionEvent.self, from: data)
            decode += clock.now - start
            start = clock.now
            try projection.apply(event)
            apply += clock.now - start
            start = clock.now
            session.update(observation(), network: V2NetworkStatus())
            model += clock.now - start
            start = clock.now
            presentation.receive(observation())
            presentation.flush(now: Double(index) * 0.3)
            present += clock.now - start
        }
        func ms(_ value: Duration) -> String {
            String(format: "%.1f", Double(value.components.seconds) * 1000 + Double(value.components.attoseconds) / 1e15)
        }
        print("BENCH items=\(itemCount) events=\(eventCount) decode=\(ms(decode))ms apply=\(ms(apply))ms model=\(ms(model))ms present=\(ms(present))ms total=\(ms(decode + apply + model + present))ms")
        #expect(projection.data.items.last?.revision == eventCount + 1)
        #expect(presentation.rows.last?.text.hasPrefix(base) == true)
        #expect(decode + apply + model + present < .seconds(30))
    }
}
