import Foundation
import Testing
@testable import ClientCore

@Suite struct SessionSidebarTests {
    private func session(_ id: String = "session", status: String = "idle", unread: Bool = false, sortAt: String? = nil) throws -> V2SessionMeta {
        var value = try fixtureObject("session")["session"] as! [String: Any]
        value["id"] = id; value["status"] = status; value["unread"] = unread
        value["sortAt"] = sortAt.map { $0 as Any } ?? NSNull()
        return try decode(value)
    }

    @Test func indicatorsFollowWebPriorityAndIdleUnreadSemantics() throws {
        #expect(SessionSidebarPresentation(try session(status: "waiting_approval", unread: true)).indicator == .waitingApproval)
        for status in ["running", "waiting", "pending"] {
            #expect(SessionSidebarPresentation(try session(status: status, unread: true)).indicator == .running)
        }
        #expect(SessionSidebarPresentation(try session(unread: true)).indicator == .unread)
        #expect(SessionSidebarPresentation(try session(unread: false)).indicator == .none)
        for status in ["offline", "interrupted", "error", "future_state"] {
            #expect(SessionSidebarPresentation(try session(status: status, unread: true)).indicator == .none)
        }
    }

    @Test func runningSessionsStayStableWhileOtherSessionsUseRecentActivity() throws {
        let values = try [
            session("old", sortAt: "2026-09-04T10:00:00Z"),
            session("run-b", status: "running", sortAt: "2026-09-05T11:00:00Z"),
            session("approval", status: "waiting_approval", sortAt: "2026-09-05T10:00:00.001Z"),
            session("run-a", status: "running", sortAt: "2026-09-03T10:00:00Z"),
            session("waiting", status: "waiting", sortAt: "2026-09-05T10:00:00Z")
        ]
        let ordered = values.sorted {
            SessionSidebarPresentation($0).precedes(SessionSidebarPresentation($1), id: $0.id, otherID: $1.id)
        }
        #expect(ordered.map(\.id) == ["run-a", "run-b", "approval", "waiting", "old"])
    }

    @Test func missingDatesAndTiesKeepDeterministicOrder() throws {
        let missing = SessionSidebarPresentation(try session("a"))
        let invalid = SessionSidebarPresentation(try session("b", sortAt: "invalid"))
        #expect(missing.sortTime == 0 && invalid.sortTime == 0)
        #expect(invalid.precedes(missing, id: "b", otherID: "a"))
        #expect(!missing.precedes(missing, id: "a", otherID: "a"))
        let first = SessionSidebarPresentation(try session(sortAt: "2026-09-05T10:00:00Z"))
        let equal = SessionSidebarPresentation(try session(sortAt: "2026-09-05T18:00:00+08:00"))
        #expect(first.sortTime > 0 && first.sortTime == equal.sortTime)
        #expect(first.precedes(equal, id: "b", otherID: "a"))
    }
}
