import Foundation
import MeshCall

@MainActor
final class MeshSessionsClient: SessionsClient {
    private let device: Workspace.Device
    let runtimes: [RuntimeChoice]
    let upload: ((String, LocalChatFile) async throws -> StagedAttachment)?
    private let connect: () async throws -> PairedContent

    init(device: Workspace.Device, runtimes: [RuntimeChoice] = [],
         upload: ((String, LocalChatFile) async throws -> StagedAttachment)? = nil, connect: @escaping () async throws -> PairedContent) {
        self.device = device
        self.runtimes = runtimes
        self.upload = upload
        self.connect = connect
    }

    func watch(id: String) -> AsyncStream<JSON> {
        AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let task = Task {
                defer { continuation.finish() }
                var transport: DeviceContentTransport?
                do {
                    let pair = try await connect()
                    try Task.checkCancellation()
                    transport = pair.transport
                    let events = try await pair.transport.subscribe(
                        ContentSubscribeRequest(sessionId: id), authorization: pair.authorization
                    )
                    for try await _ in events {
                        try Task.checkCancellation()
                        continuation.yield(try await snapshot(id: id))
                    }
                } catch {
                    // Failed and completed streams both require reopening the device tunnel.
                }
                guard !Task.isCancelled else { return }
                continuation.yield(["type": "control", "control": ["state": "disconnected", "steer": "none", "pending": [], "queued": []]])
                await transport?.invalidate()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func listMessages(id: String, beforeSeq: Int?, limit: Int) async throws -> (messages: [JSON], hasMore: Bool) {
        let mode = beforeSeq.map { "history&beforeOrderSeq=\($0)" } ?? "latest"
        let result = try await request(id: id, "GET", "timeline?mode=\(mode)&limit=\(limit)")
        return (messages(result["items"]?.array ?? []), result["hasMore"]?.bool ?? false)
    }

    func send(id: String, clientMsgId: String, content: String) async throws -> String {
        try await send(id: id, clientMsgId: clientMsgId, content: content, attachments: [])
    }

    func send(id: String, clientMsgId: String, content: String, attachments: [StagedAttachment]) async throws -> String {
        var fields: [String: JSON] = ["clientMessageId": .string(clientMsgId), "content": .string(content)]
        if !attachments.isEmpty {
            fields["attachments"] = .array(attachments.map(\.reference))
            fields["sealedAttachmentKeys"] = .array(attachments.map(\.key))
        }
        _ = try await request(id: id, "POST", "runtime/messages", .object(fields))
        return clientMsgId
    }

    func answer(id: String, requestId: String, optionId: String) async throws {
        _ = try await request(id: id, "POST", "runtime/notices/\(segment(requestId))/respond", [
            "actionId": .string(optionId), "responseId": .string(UUID().uuidString),
        ])
    }

    func stop(id: String) async throws {
        _ = try await request(id: id, "POST", "runtime/interrupt", ["commandId": .string(UUID().uuidString)])
    }

    func setConfig(id: String, configId: String, value: String) async throws -> JSON {
        _ = try await request(id: id, "PATCH", "runtime/selections", ["selections": .object([configId: .string(value)])])
        return try await snapshot(id: id)["session"] ?? .null
    }


    func create(runtime: RuntimeChoice, cwd: String, content: String, operationID: String,
                project: Workspace.Project?) async throws -> Workspace.Session {
        let title = String(content.prefix { !$0.isNewline }.prefix(80))
        var fields: [String: JSON] = [
            "connectorId": .string(device.id), "runtime": .string(runtime.type), "runtimeId": .string(runtime.id),
            "cwd": .string(cwd), "content": .string(content), "clientMessageId": .string(operationID),
            "title": .string(title),
        ]
        if let projectID = project?.remoteId { fields["projectId"] = .string(projectID) }
        let result = try await deviceRequest("POST", "/api/v2/sessions/create-and-start", .object(fields))
        let session = result["session"]
        guard let id = session?["id"]?.string else { throw NativeAccountError.invalidResponse }
        return .init(
            id: id, title: session?["title"]?.string ?? title, agent: runtime.type,
            device_id: device.id, cwd: cwd, state: session?["status"]?.string ?? "running",
            unread: false, pinned: false, updated_at: session?["lastActivityAt"]?.string ?? Date().ISO8601Format()
        )
    }

    private var workspacePath: String { "/api/v2/connectors/\(segment(device.id))" }

    func readFile(root: String, path: String) async throws -> String {
        let data = try await deviceRequest("POST", "\(workspacePath)/fs/readText?root=\(segment(root))",
                                           ["path": .string(path), "maxBytes": .number(256 * 1024)])
        guard let content = data["content"]?.string else { throw NativeAccountError.invalidResponse }
        return content
    }

    func startTerminal(root: String) async throws -> String {
        let data = try await deviceRequest("POST", "\(workspacePath)/terminals-v2?root=\(segment(root))",
                                           ["cols": 80, "rows": 24])
        guard let id = data["result"]?["terminalId"]?.string else { throw NativeAccountError.invalidResponse }
        return id
    }

    func writeTerminal(id: String, line: String) async throws {
        let bytes = Data((line + "\n").utf8)
        _ = try await deviceRequest("POST", "\(workspacePath)/terminals-v2/\(segment(id))/write",
                                    ["dataBase64": .string(bytes.base64EncodedString())])
    }

    func closeTerminal(id: String) async throws {
        _ = try await deviceRequest("DELETE", "\(workspacePath)/terminals-v2/\(segment(id))")
    }

    func terminalEvents(id: String, fromSeq: Int, receive: (JSON) -> Void) async throws {
        let peer = try await connect()
        do {
            let events = try await peer.transport.subscribe(
                ContentSubscribeRequest(fromSeq: fromSeq, stream: "terminal", terminalId: id), authorization: peer.authorization
            )
            for try await event in events {
                try Task.checkCancellation()
                receive(try JSON.decode(JSONEncoder().encode(event)))
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            await peer.transport.invalidate()
            throw error
        }
    }

    private func request(id: String, _ method: String, _ path: String, _ body: JSON? = nil) async throws -> JSON {
        try await deviceRequest(method, "/api/v2/sessions/\(segment(id))/\(path)", body)
    }

    private func deviceRequest(_ method: String, _ path: String, _ body: JSON? = nil) async throws -> JSON {
        let pair = try await connect()
        try Task.checkCancellation()
        let wire = try body.map { try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode($0)) }
        let result = try await pair.transport.request(
            ContentRequest(body: wire, method: method, path: path),
            authorization: pair.authorization
        )
        let payload = try result.body.map { try JSON.decode(JSONEncoder().encode($0)) } ?? .null
        guard (200..<300).contains(result.status), payload["ok"]?.bool != false else {
            throw SessionsClientError.failedPrecondition(
                payload["detail"]?["message"]?.string ?? payload["message"]?.string ?? "HTTP \(result.status)"
            )
        }
        return payload
    }

    private func snapshot(id: String) async throws -> JSON {
        let data = try await request(id: id, "GET", "snapshot")
        let session = data["session"] ?? .null
        let timeline = data["timeline"] ?? .null
        let items = messages(timeline["items"]?.array ?? [])
        let time = session["lastActivityAt"] ?? .string(ISO8601DateFormatter().string(from: Date()))
        return [
            "type": "snapshot",
            "session": [
                "id": .string(id), "title": session["title"] ?? "",
                "agent": session["runtimeType"] ?? "",
                "device": ["id": .string(device.id), "name": .string(device.name)],
                "cwd": session["cwd"] ?? "", "created_at": time, "updated_at": time,
                "message_count": .number(Double(items.count)), "config": config(data),
            ],
            "messages": .array(items), "has_more": timeline["hasMore"] ?? false,
            "control": [
                "state": data["state"]?["status"] ?? session["status"] ?? "idle",
                "steer": "none", "pending": pending(data["notices"]), "queued": [],
            ],
        ]
    }

    private func config(_ data: JSON) -> JSON {
        let allowed = Set((data["effectiveCapabilities"]?["capabilities"]?.array ?? []).compactMap { entry -> String? in
            guard entry["allowed"]?.bool == true, entry["available"]?.bool == true else { return nil }
            return entry["capabilityId"]?.string
        })
        let out = ["model", "permission"].compactMap { kind -> JSON? in
            guard allowed.contains("catalog.\(kind)") else { return nil }
            let key = kind + "s"
            let values = (data["catalogs"]?[key]?[key]?.array ?? []).compactMap { entry -> JSON? in
                guard let id = entry["selectionId"]?.string ?? entry["id"]?.string else { return nil }
                return ["value": .string(id), "name": entry["displayName"] ?? .string(id), "description": entry["description"] ?? .null]
            }
            if values.isEmpty { return nil }
            let name = kind == "model" ? String(localized: "connection.model") : String(localized: "connection.permission")
            return [
                "id": .string(kind), "category": .string(kind), "name": .string(name), "options": .array(values),
                "current": data["state"]?["selections"]?[kind] ?? "",
            ]
        }
        return .array(out)
    }

    private func pending(_ source: JSON?) -> JSON {
        let notices = (source?.array ?? []).filter {
            $0["status"]?.string == "open" && $0["interactionType"]?.string == "approval" && $0["responseRequired"]?.bool == true
        }
        return .array(notices.compactMap { entry in
            guard let id = entry["noticeId"]?.string else { return nil }
            let actions = (entry["actions"]?.array ?? []).compactMap { action -> JSON? in
                guard let option = action["actionId"]?.string, action["input"]?["required"]?.bool != true else { return nil }
                return ["id": .string(option), "name": action["label"] ?? .string(option),
                        "kind": action["style"]?.string == "danger" ? "reject_once" : "allow_once"]
            }
            return ["request_id": .string(id), "message_id": entry["source"]?["timelineItemId"] ?? "",
                    "title": entry["title"] ?? "", "options": .array(actions)]
        })
    }

    private static let terminalStatuses: Set<String> = ["done", "failed", "cancelled", "interrupted"]

    private func messages(_ items: [JSON]) -> [JSON] {
        var turnID: String?
        return items.compactMap { item in
            guard let id = item["id"]?.string, let sequence = item["orderSeq"],
                  let role = item["role"]?.string else { return nil }
            let user = role == "user"
            guard user || role == "assistant" else { return nil }
            let content = item["content"]
            let thinking = content?["isThinking"]?.bool == true
            guard let text = content?["text"]?.string ?? content?["message"]?.string, !text.isEmpty else { return nil }
            if user { turnID = id }
            var result: [String: JSON] = [
                "id": .string(id), "seq": sequence, "role": user ? "user" : "assistant",
                "created_at": item["createdAt"] ?? "",
                "done": .bool(Self.terminalStatuses.contains(item["status"]?.string ?? "")),
                "parts": [["type": thinking ? "thinking" : "text", "text": .string(text)]],
            ]
            if user {
                result["client_msg_id"] = item["source"]?["clientMessageId"]
                if item["status"]?.string == "failed" {
                    let message = content?["error"]?["code"]?.string == "runtime_unavailable"
                        ? String(localized: "connection.agent_unavailable")
                        : String(localized: "connection.delivery_failed")
                    result["delivery_error"] = .string(message)
                }
            } else {
                result["turn_id"] = .string(turnID ?? id)
            }
            return .object(result)
        }
    }

    private func segment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? ""
    }
}


struct RuntimeChoice: Identifiable, Hashable {
    let id: String
    let type: String
    let name: String
}
