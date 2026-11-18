import Foundation
import Testing
@testable import ClientCore

/// Protocol 1.2 Agent collaboration: session origin, supervision edges and the
/// timeline shapes the collaboration tools produce.
@Suite @MainActor struct SessionCollaborationTests {
    private func sessionObject(id: String = "session", title: Any = "Task", extra: [String: Any] = [:]) throws -> [String: Any] {
        var object = (try fixtureObject("sessions")["sessions"] as! [[String: Any]])[0]
        object["id"] = id; object["title"] = title
        for (key, value) in extra { object[key] = value }
        return object
    }

    private func edge(_ supervisor: String, target: String = "session", state: String = "active", id: String? = nil) -> [String: Any] {
        ["supervisionId": id ?? "sup-\(supervisor)-\(state)", "supervisorSessionId": supervisor, "targetSessionId": target,
         "state": state, "createdBy": "agent"]
    }

    private func item(type: String, role: String? = nil, content: [String: Any]) throws -> V2TimelineItem {
        var object = try itemObject()
        object["type"] = type; object["content"] = content
        if let role { object["role"] = role } else { object.removeValue(forKey: "role") }
        return try decode(object)
    }

    // MARK: Decoding

    @Test func olderSessionsDecodeWithoutCollaborationFields() throws {
        let session: V2SessionMeta = try decode(try sessionObject())
        #expect(session.origin == nil && session.supervisors == nil && session.supervised == nil)
        #expect(SessionCollaborationPresentation.indicator(for: session).isEmpty)
        #expect(SessionCollaborationPresentation.badges(for: session, directory: .empty).isEmpty)
    }

    @Test func originAndEdgesDecodeAndSurviveTheCacheEncoding() throws {
        let session: V2SessionMeta = try decode(try sessionObject(extra: [
            "origin": ["kind": "agent", "bySessionId": "lead", "byDeviceId": "device", "depth": 1],
            "supervisors": [edge("lead")],
            "supervised": [edge("session", target: "worker")],
        ]))
        #expect(session.origin == V2SessionOrigin(kind: "agent", bySessionId: "lead", byDeviceId: "device", depth: 1))
        #expect(session.supervisors?.first?.state == .active && session.supervisors?.first?.createdBy == .agent)
        #expect(session.supervised?.first?.targetSessionId == "worker")
        let restored = try JSONDecoder().decode(V2SessionMeta.self, from: JSONEncoder().encode(session))
        #expect(restored == session)
    }

    @Test func unknownOrMalformedCollaborationValuesNeverRejectTheSession() throws {
        let session: V2SessionMeta = try decode(try sessionObject(extra: [
            "origin": ["kind": "robot", "bySessionId": 7],
            "supervisors": [edge("lead", state: "sleeping"), ["supervisionId": 1], "junk", edge("other")],
            "supervised": "not a list",
        ]))
        #expect(session.origin?.kind == "robot" && session.origin?.agentSessionId == nil)
        #expect(session.supervisors?.count == 4)
        #expect(session.supervisors?[0].state == .unknown && session.supervisors?[0].isValid == false)
        #expect(session.supervisors?.filter(\.isValid).map(\.supervisorSessionId) == ["other"])
        #expect(session.supervised == nil)

        let nullOrigin: V2SessionMeta = try decode(try sessionObject(extra: ["origin": NSNull(), "supervisors": NSNull()]))
        #expect(nullOrigin.origin == nil && nullOrigin.supervisors == nil)
    }

    @Test func timelineShapesDecodeFromContent() throws {
        let agent = try item(type: "message", role: "user", content: [
            "text": "Please fix it", "author": ["kind": "agent", "sessionId": "lead", "deviceId": "device", "supervisionId": NSNull()],
        ])
        #expect(agent.messageAuthor?.kind == .agent && agent.messageAuthor?.sessionId == "lead" && agent.messageAuthor?.supervisionId == nil)
        #expect(agent.displayText == "Please fix it")

        let wake = try item(type: "message", role: "user", content: ["text": "digest", "author": ["kind": "supervision", "supervisionId": "s1"]])
        #expect(wake.messageAuthor?.kind == .supervision && wake.messageAuthor?.supervisionId == "s1")

        let unknownAuthor = try item(type: "message", role: "user", content: ["text": "x", "author": ["kind": "robot"]])
        #expect(unknownAuthor.messageAuthor == nil)
        #expect(try item(type: "message", role: "user", content: ["text": "typed"]).messageAuthor == nil)

        let escalation = try item(type: "system", content: [
            "kind": "collab_escalation", "question": "Deploy now?", "context": "Tests pass", "fromSessionId": "worker", "targetSessionId": "lead",
        ])
        #expect(escalation.collabEscalation == V2CollabEscalation(.object([
            "kind": .string("collab_escalation"), "question": .string("Deploy now?"), "context": .string("Tests pass"),
            "fromSessionId": .string("worker"), "targetSessionId": .string("lead"),
        ])))
        #expect(escalation.collabEscalation?.context == "Tests pass" && escalation.collabEscalation?.fromSessionId == "worker")
        #expect(try item(type: "system", content: ["kind": "error", "message": "x"]).collabEscalation == nil)

        let tool = try item(type: "tool", content: ["kind": "tool_call", "name": "aa_spawn", "collabTool": ["tool": "aa_spawn", "sessionId": "worker"]])
        #expect(tool.collabTool?.tool == "aa_spawn" && tool.collabTool?.sessionId == "worker")
        #expect(try item(type: "tool", content: ["kind": "tool_call", "collabTool": ["tool": ""]]).collabTool == nil)
        #expect(try item(type: "tool", content: ["kind": "command", "command": "ls"]).collabTool == nil)
    }

    // MARK: Presentation

    @Test func headerBadgesNameListedSessionsAndOpenOnlyThose() throws {
        let lead: V2SessionMeta = try decode(try sessionObject(id: "lead", title: "Lead task"))
        let untitled: V2SessionMeta = try decode(try sessionObject(id: "quiet", title: NSNull()))
        let session: V2SessionMeta = try decode(try sessionObject(extra: [
            "origin": ["kind": "agent", "bySessionId": "lead", "depth": 1],
            "supervisors": [edge("lead", state: "ended"), edge("lead"), edge("quiet", state: "paused"),
                edge("gone", state: "ended"), edge("elsewhere", target: "other"), edge("session")],
        ]))
        let directory = SessionCollaborationDirectory(sessions: [lead, untitled, session])
        let badges = SessionCollaborationPresentation.badges(for: session, directory: directory)
        #expect(badges.map(\.label) == ["由 Lead task 创建", "被 Lead task 监督", "被 未命名会话 监督（已暂停）", "被 另一个会话 监督（已结束）"])
        #expect(badges.map(\.canOpen) == [true, true, true, false])
        #expect(badges.map(\.sessionId) == ["lead", "lead", "quiet", "gone"])
        #expect(badges[1].kind == .supervisedBy(.active) && badges[0].kind == .createdBy)
        #expect(Set(badges.map(\.id)).count == badges.count)
    }

    @Test func listIndicatorMarksAgentCreatedAndCurrentlySupervisedSessions() throws {
        func indicator(_ extra: [String: Any]) throws -> SessionCollaborationPresentation.ListIndicator {
            SessionCollaborationPresentation.indicator(for: try decode(try sessionObject(extra: extra)))
        }
        #expect(try indicator(["origin": ["kind": "agent", "bySessionId": "lead", "depth": 1]]) == .init(agentCreated: true, supervised: false))
        #expect(try indicator(["supervisors": [edge("lead", state: "paused")]]) == .init(agentCreated: false, supervised: true))
        #expect(try indicator(["supervisors": [edge("lead", state: "ended")]]).isEmpty)
        // Being a supervisor does not mark the row.
        #expect(try indicator(["supervised": [edge("session", target: "worker")]]).isEmpty)
    }

    @Test func toolLabelsAndAuthorLabels() throws {
        let expected = ["aa_spawn": "新建会话", "aa_send": "发消息", "aa_steer": "纠偏", "aa_interrupt": "打断", "aa_status": "查看状态",
            "aa_read": "查看进展", "aa_wait": "等待", "aa_respond": "代答审批", "aa_plan_review": "审阅计划", "aa_supervise": "开始监督",
            "aa_unsupervise": "停止监督", "aa_escalate": "交给人决定", "aa_close": "关闭会话"]
        for (tool, label) in expected { #expect(SessionCollaborationPresentation.toolLabel(tool) == label) }
        #expect(SessionCollaborationPresentation.toolLabel("aa_future") == nil)

        let lead: V2SessionMeta = try decode(try sessionObject(id: "lead", title: "Lead task"))
        let directory = SessionCollaborationDirectory(sessions: [lead])
        let agent = V2MessageAuthor(.object(["kind": .string("agent"), "sessionId": .string("lead")]))
        #expect(SessionCollaborationPresentation.agentAuthorLabel(agent, directory: directory) == "由 Lead task 的 Agent 发送")
        let stranger = V2MessageAuthor(.object(["kind": .string("agent"), "sessionId": .string("nope")]))
        #expect(SessionCollaborationPresentation.agentAuthorLabel(stranger, directory: directory) == "由 另一个会话 的 Agent 发送")
        let wake = V2MessageAuthor(.object(["kind": .string("supervision")]))
        #expect(SessionCollaborationPresentation.agentAuthorLabel(wake, directory: directory) == nil)
    }

    @Test func collaborationToolsStayOnTheirOwnRowWithTheirLabel() throws {
        let spawn = try item(type: "tool", content: ["kind": "tool_call", "name": "aa_spawn", "collabTool": ["tool": "aa_spawn", "sessionId": "worker"]])
        #expect(TimelineRowStructure(spawn).groupKind == .single)
        let entry = TimelineEntryPresentation(item: spawn, cwd: nil)
        #expect(entry.kind == .tool && entry.title == "新建会话" && entry.symbol == "person.2")

        let future = try item(type: "tool", content: ["kind": "tool_call", "name": "aa_future", "collabTool": ["tool": "aa_future"]])
        #expect(TimelineEntryPresentation(item: future, cwd: nil).title == "aa_future")

        let plain = try item(type: "tool", content: ["kind": "tool_call", "name": "Read"])
        #expect(TimelineRowStructure(plain).groupKind == .tools)

        let escalation = try item(type: "system", content: ["kind": "collab_escalation", "question": "Q", "fromSessionId": "w"])
        #expect(TimelineRowStructure(escalation).groupKind == .single && escalation.isVisibleInChat)
    }
}
