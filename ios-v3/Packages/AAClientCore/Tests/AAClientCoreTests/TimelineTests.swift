import Foundation
import Testing

@testable import AAClientCore

@Suite("Timeline model")
struct TimelineTests {
    static let snapshot = """
    {"type":"snapshot","has_more":true,
     "session":{"id":"s1","title":"Fix bug","agent":"pi","device":{"id":"d1","name":"Mac"},"cwd":"/work/aa",
                "created_at":"2026-11-20T08:00:00Z","updated_at":"2026-11-20T09:00:00Z","message_count":3,
                "config":[{"id":"model","name":"Model","category":"model","current":"m1",
                           "options":[{"value":"m1","name":"Model One"},{"value":"m2","name":"Model Two"}]}]},
     "messages":[
       {"id":"u1","role":"user","seq":0,"done":true,"created_at":"2026-11-20T08:00:00Z","client_msg_id":"c1",
        "parts":[{"type":"text","text":"hello"},{"type":"image","path":"/a.png","name":"a.png","mime":"image/png","size":10}]},
       {"id":"a1","role":"assistant","turn_id":"u1","seq":1,"done":true,"created_at":"2026-11-20T08:00:01Z",
        "parts":[{"type":"tool","id":"t1","title":"Read a.py","kind":"read","status":"completed","input":{"path":"a.py"}}]},
       {"id":"a2","role":"assistant","turn_id":"u1","seq":2,"done":false,"created_at":"2026-11-20T08:00:02Z",
        "parts":[{"type":"hologram","beam":1}]}
     ],
     "control":{"state":"running","steer":"interrupt","pending":[
        {"request_id":"r1","message_id":"a1","tool_call_id":"t1","title":"Run rm",
         "options":[{"id":"o1","name":"Allow","kind":"allow_once"},{"id":"o2","name":"Reject","kind":"reject_once"}]}],
      "queued":[{"client_msg_id":"q1","author":"me","content":"next"}]}}
    """

    @Test func decodesSnapshotWithUnknownParts() throws {
        let raw = try JSONValue(json: Data(Self.snapshot.utf8))
        guard case .snapshot(let session, let messages, let hasMore, let control) = try WatchEvent(json: raw) else {
            Issue.record("not a snapshot")
            return
        }
        #expect(session.title == "Fix bug")
        #expect(session.config.first?.currentName == "Model One")
        #expect(hasMore)
        #expect(messages.count == 3)
        #expect(messages[0].text == "hello")
        if case .image(let image) = messages[0].parts[1] { #expect(image.isImage) } else { Issue.record("image part") }
        if case .tool(let tool) = messages[1].parts[0] { #expect(tool.input?["path"]?.stringValue == "a.py") } else { Issue.record("tool part") }
        if case .unknown(let value) = messages[2].parts[0] { #expect(value["beam"]?.intValue == 1) } else { Issue.record("unknown part") }
        #expect(control.isRunning)
        #expect(control.pending.first?.options.first?.isAllow == true)
        #expect(control.queued.first?.content == "next")
    }

    @Test func partsRoundTrip() throws {
        let raw = try JSONValue(json: Data(Self.snapshot.utf8))
        let messages = try (raw["messages"] ?? .null).decode(as: [Message].self)
        let again = try JSONValue(encoding: messages).decode(as: [Message].self)
        #expect(again == messages)
    }

    @Test func conversationStateReducesEvents() throws {
        var state = ConversationState()
        let raw = try JSONValue(json: Data(Self.snapshot.utf8))
        state.apply(WatchUpdate(raw: raw, event: try WatchEvent(json: raw)))
        #expect(state.messages.count == 3)
        #expect(state.oldestSeq == 0)

        // Replace a message by id, append a new one.
        let replaced: JSONValue = [
            "type": "message",
            "message": ["id": "a2", "role": "assistant", "turn_id": "u1", "seq": 2, "done": true, "created_at": "x",
                        "parts": [["type": "text", "text": "done"]]],
        ]
        state.apply(WatchUpdate(raw: replaced, event: try WatchEvent(json: replaced)))
        let appended: JSONValue = [
            "type": "message",
            "message": ["id": "a3", "role": "assistant", "turn_id": "u1", "seq": 3, "done": true, "created_at": "x",
                        "parts": [["type": "text", "text": "more"]]],
        ]
        state.apply(WatchUpdate(raw: appended, event: try WatchEvent(json: appended)))
        #expect(state.messages.count == 4)
        #expect(state.typedMessages[2].text == "done")
        #expect(state.typedMessages[3].text == "more")

        let control: JSONValue = ["type": "control", "control": ["state": "idle", "steer": "interrupt", "pending": [], "queued": []]]
        state.apply(WatchUpdate(raw: control, event: try WatchEvent(json: control)))
        #expect(!state.control.isRunning)

        // Older page prepended without duplicates.
        let older: [JSONValue] = [
            ["id": "u0", "role": "user", "seq": -1, "done": true, "created_at": "x", "parts": []],
            ["id": "u1", "role": "user", "seq": 0, "done": true, "created_at": "x", "parts": []],
        ]
        state.prepend(older, hasMore: false)
        #expect(state.messages.count == 5)
        #expect(state.messages.first?["id"]?.stringValue == "u0")
        #expect(!state.hasMore)

        let cached = try #require(CachedConversation(state))
        #expect(cached.typedSession?.id == "s1")
    }

    @Test func groupsByAgentThenProject() {
        let sessions = [
            SessionSummary(id: "1", title: "a", agent: "pi", deviceID: "d", cwd: "/w/aa", updatedAt: "2026-11-20T08:00:00Z"),
            SessionSummary(id: "2", title: "b", agent: "claude", deviceID: "d", cwd: "/w/aa", updatedAt: "2026-11-20T09:00:00Z"),
            SessionSummary(id: "3", title: "c", agent: "pi", deviceID: "d", cwd: "/w/other/", updatedAt: "2026-11-20T10:00:00Z"),
        ]
        let groups = AgentGroup.group(sessions)
        #expect(groups.map(\.agent) == ["pi", "claude"])
        #expect(groups[0].projects.map(\.name) == ["other", "aa"])
    }

    @Test func deviceEventsApply() {
        let a = DeviceRecord(id: "a", name: "Zed")
        let b = DeviceRecord(id: "b", name: "Alpha")
        var devices = WatchDevicesEvent.snapshot([a, b]).apply(to: [])
        #expect(devices.map(\.id) == ["b", "a"])
        var offline = a
        offline.presence = "offline"
        devices = WatchDevicesEvent.upsert(offline).apply(to: devices)
        #expect(devices.first { $0.id == "a" }?.isOnline == false)
        devices = WatchDevicesEvent.remove("b").apply(to: devices)
        #expect(devices.map(\.id) == ["a"])
    }
}
