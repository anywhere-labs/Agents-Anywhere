import Foundation

/// Stands in for the computer: replays Fixtures/session-demo.json with real timing (script semantics documented at the
/// top of v3poc/fixtures/build.py) and synthesizes small sessions for the rest of workspace.json. The state lives
/// here, not on the phone; the app only sees what `watch` sends.
@MainActor
final class MockSessionsClient: SessionsClient {
    private final class Source {
        var state: SessionState
        var watchers: [UUID: AsyncStream<JSON>.Continuation] = [:]
        var task: Task<Void, Never>?
        var scriptStarted = false
        var waiters: [String: CheckedContinuation<Void, Never>] = [:]
        init(state: SessionState) { self.state = state }
    }

    static let deviceName = "iPhone"

    private let workspace: Workspace
    private let demo: JSON?
    private var sources: [String: Source] = [:]
    private var rng = SeededGenerator(seed: 0xA4)

    init(workspace: Workspace, demo: JSON?) {
        self.workspace = workspace
        self.demo = demo
        for summary in workspace.sessions {
            sources[summary.id] = Source(state: makeState(summary))
        }
    }

    private var accountName: String { demo?["account"]?["name"]?.string ?? workspace.account.name }
    private var demoSessionID: String? { demo?["snapshot"]?["session"]?["id"]?.string }

    // MARK: SessionsClient

    func watch(id: String) -> AsyncStream<JSON> {
        AsyncStream { continuation in
            guard let source = sources[id] else { continuation.finish(); return }
            let token = UUID()
            source.watchers[token] = continuation
            continuation.yield(source.state.snapshot)
            let remove: @MainActor () -> Void = { [weak source] in source?.watchers[token] = nil }
            continuation.onTermination = { _ in Task { @MainActor in remove() } }
            if id == StressConfig.sessionID, !source.scriptStarted, let config = StressConfig.current {
                source.scriptStarted = true
                source.task = Task { [weak self] in await self?.runStress(config, in: source) }
            }
            // The demo's script starts the first time anyone watches it and keeps running on the computer afterwards.
            if id == demoSessionID, !source.scriptStarted, let steps = demo?["script"]?.array {
                source.scriptStarted = true
                source.task = Task { [weak self] in
                    await self?.play(steps, in: source, substitute: { $0 })
                    source.task = nil
                }
            }
        }
    }

    func listMessages(id: String, beforeSeq: Int?, limit: Int) async throws -> (messages: [JSON], hasMore: Bool) {
        guard let source = sources[id] else { throw SessionsClientError.notFound(id) }
        // Whole turns are not kept together here (the real `list_messages` extends the page to the turn start).
        let before = source.state.messages.filter { ($0["seq"]?.int ?? 0) < (beforeSeq ?? Int.max) }
        return (Array(before.suffix(limit)), before.count > limit)
    }

    @discardableResult
    func send(id: String, clientMsgId: String, content: String) async throws -> String {
        guard let source = sources[id] else { throw SessionsClientError.notFound(id) }
        if let existing = source.state.messages.first(where: { $0["client_msg_id"]?.string == clientMsgId }) {
            return existing["id"]?.string ?? ""
        }
        let token = Self.token()
        let userID = "m-u-\(token)"
        var user: JSON = ["id": .string(userID), "role": "user", "client_msg_id": .string(clientMsgId),
                          "created_at": .string(Self.now()), "done": true, "rewindable": true,
                          "parts": [["type": "text", "text": .string(content)]]]
        if source.task != nil {
            // Running: `control.steer` is native, so the message joins the current turn and no new reply starts.
            user["steered"] = true
            push(["type": "message", "message": user], in: source)
            return userID
        }
        push(["type": "message", "message": user], in: source)
        guard let reply = demo?["reply"]?.array else { return userID }
        source.task = Task { [weak self] in
            await self?.play(reply, in: source) {
                $0.replacingOccurrences(of: "$TURN", with: userID).replacingOccurrences(of: "$X", with: token)
            }
            source.task = nil
        }
        return userID
    }

    func answer(id: String, requestId: String, optionId: String) async throws {
        guard let source = sources[id] else { throw SessionsClientError.notFound(id) }
        guard var pending = source.state.control["pending"]?.array,
              let position = pending.firstIndex(where: { $0["request_id"]?.string == requestId }) else {
            throw SessionsClientError.failedPrecondition("这个请求已经处理过了")
        }
        let request = pending.remove(at: position)
        var control = source.state.control
        control["pending"] = .array(pending)
        var answered = control["answered"]?.array ?? []
        answered.append(["request_id": .string(requestId), "by": .string(accountName), "device": .string(Self.deviceName),
                         "option_id": .string(optionId), "at": .string(Self.now())])
        control["answered"] = .array(answered)
        push(["type": "control", "control": control], in: source)

        if let waiter = source.waiters.removeValue(forKey: requestId) {
            waiter.resume()
        } else if source.task == nil {
            // Synthesized sessions have no script: settle the waiting tool call and go idle.
            source.task = Task { [weak self] in
                await self?.settleSynthesizedApproval(request, optionID: optionId, in: source)
                source.task = nil
            }
        }
    }

    func stop(id: String) async throws {
        guard let source = sources[id] else { throw SessionsClientError.notFound(id) }
        source.task?.cancel()
        source.task = nil
        for waiter in source.waiters.values { waiter.resume() }
        source.waiters = [:]
        for var message in source.state.unfinishedMessages {
            message["done"] = true
            message["interrupted"] = true
            if var part = message["parts"]?[0], part["type"]?.string == "tool" {
                part["status"] = "failed"
                message["parts"] = [part]
            }
            push(["type": "message", "message": message], in: source)
        }
        var control = source.state.control
        control["state"] = "idle"
        control["pending"] = []
        push(["type": "control", "control": control], in: source)
    }

    @discardableResult
    func setConfig(id: String, configId: String, value: String) async throws -> JSON {
        guard let source = sources[id] else { throw SessionsClientError.notFound(id) }
        var session = source.state.session
        session["config"] = .array((session["config"]?.array ?? []).map { option in
            guard option["id"]?.string == configId else { return option }
            var option = option
            option["current"] = .string(value)
            return option
        })
        push(["type": "session", "session": session], in: source)
        return session
    }

    // MARK: Replay

    private func push(_ event: JSON, in source: Source) {
        let applied = source.state.apply(event, assignSeq: true, stamp: true)
        for watcher in source.watchers.values { watcher.yield(applied) }
    }

    private func play(_ steps: [JSON], in source: Source, substitute: (String) -> String) async {
        for raw in steps {
            let step = raw.mapStrings(substitute)
            if let wait = step["wait"]?.double, wait > 0 {
                guard await Self.sleep(ms: wait) else { return }
            }
            if Task.isCancelled { return }
            if var event = step["event"] {
                // A real Connector pushes the whole control: answers the replayer recorded stay in every later one.
                if event["type"]?.string == "control", var control = event["control"] {
                    var answered = control["answered"]?.array ?? []
                    let known = Set(answered.compactMap { $0["request_id"]?.string })
                    answered += (source.state.control["answered"]?.array ?? []).filter { !known.contains($0["request_id"]?.string ?? "") }
                    control["answered"] = .array(answered)
                    event["control"] = control
                }
                push(event, in: source)
            } else if let stream = step["stream"], let message = stream["message"] {
                guard await self.stream(message, cps: stream["cps"]?.double ?? 60,
                    interval: stream["interval"]?.double ?? 333, in: source) else { return }
            } else if step["until"]?.string == "answer", let requestID = step["request_id"]?.string {
                let stillPending = source.state.control["pending"]?.array?.contains { $0["request_id"]?.string == requestID } ?? false
                if stillPending {
                    await withCheckedContinuation { source.waiters[requestID] = $0 }
                }
            }
            if Task.isCancelled { return }
        }
    }

    /// Pushes the whole item every `interval` ms while its text grows at `cps`; the last push is the item as given.
    private func stream(_ message: JSON, cps: Double, interval: Double, in source: Source) async -> Bool {
        guard let part = message["parts"]?[0] else { push(["type": "message", "message": message], in: source); return true }
        let isTool = part["type"]?.string == "tool"
        let field = isTool ? "output" : "text"
        let full = Array(part[field]?.string ?? "")
        let perPush = max(1, cps * interval / 1000)
        var shown = 0.0
        while true {
            shown += perPush * Double.random(in: 0.7 ... 1.3, using: &rng)
            guard Int(shown) < full.count else { break }
            var partialPart = part
            partialPart[field] = .string(String(full[0 ..< Int(shown)]))
            if isTool { partialPart["status"] = "in_progress" }
            var partial = message
            partial["parts"] = [partialPart]
            partial["done"] = false
            push(["type": "message", "message": partial], in: source)
            guard await Self.sleep(ms: interval) else { return false }
        }
        push(["type": "message", "message": message], in: source)
        return true
    }

    private func settleSynthesizedApproval(_ request: JSON, optionID: String, in source: Source) async {
        let rejected = optionID.hasPrefix("reject")
        if let messageID = request["message_id"]?.string, var message = source.state.message(messageID), var part = message["parts"]?[0] {
            part["status"] = rejected ? "failed" : "completed"
            part["output"] = rejected ? "已拒绝" : "Everything up-to-date"
            message["parts"] = [part]
            message["done"] = true
            push(["type": "message", "message": message], in: source)
        }
        guard await Self.sleep(ms: 400) else { return }
        let turn = source.state.messages.last { $0["role"]?.string == "user" }?["id"]?.string ?? "m-s-u1"
        let text = rejected ? "好的，先不执行这一步。" : "已推送。这个会话是合成的演示数据，到这里就结束了。"
        guard await stream(["id": .string("m-s-\(Self.token())"), "role": "assistant", "turn_id": .string(turn),
                            "created_at": .string(Self.now()), "done": true, "parts": [["type": "text", "text": .string(text)]]],
                           cps: 50, interval: 333, in: source) else { return }
        var control = source.state.control
        control["state"] = "idle"
        push(["type": "control", "control": control], in: source)
    }

    // MARK: Sessions

    private func makeState(_ summary: Workspace.Session) -> SessionState {
        if summary.id == StressConfig.sessionID, let config = StressConfig.current { return stressSnapshot(config, summary: summary) }
        if let snapshot = demo?["snapshot"], snapshot["session"]?["id"]?.string == summary.id, let state = SessionState(snapshot: snapshot) {
            return state
        }
        return synthesize(summary)
    }

    /// One user item and one assistant text item based on the title. A "waiting" summary also gets a pending command.
    private func synthesize(_ summary: Workspace.Session) -> SessionState {
        let device = workspace.devices.first { $0.id == summary.device_id }
        let session: JSON = [
            "id": .string(summary.id), "title": .string(summary.title), "agent": .string(summary.agent),
            "device": ["id": .string(summary.device_id), "name": .string(device?.name ?? summary.device_id)],
            "cwd": .string(summary.cwd), "created_at": .string(summary.updated_at), "updated_at": .string(summary.updated_at),
            "message_count": 2, "config": Self.config(for: summary.agent),
        ]
        // Like pushed items, synthesized ones are stamped when they first exist (here: when the replayer starts).
        let created = SessionState.now()
        var messages: [JSON] = [
            ["id": "m-s-u1", "role": "user", "created_at": .string(created), "seq": 0, "done": true, "rewindable": true,
             "parts": [["type": "text", "text": .string("帮我处理一下：\(summary.title)")]]],
            ["id": "m-s-a1", "role": "assistant", "turn_id": "m-s-u1", "created_at": .string(created), "seq": 1, "done": true,
             "parts": [["type": "text", "text": .string("好的。关于「\(summary.title)」，我先看了相关代码和最近的提交，整理如下：\n\n- **现状**：这部分逻辑分散在两个模块里，各自维护一份状态。\n- **建议**：先补一组覆盖边界情况的测试，再分两步合并。\n\n需要我继续吗？")]]],
        ]
        var control: JSON = ["state": .string(summary.state == "waiting" ? "running" : summary.state == "error" ? "error" : "idle"),
                             "steer": "native", "pending": [], "queued": [], "answered": []]
        if summary.state == "error" { control["error"] = "设备断开，任务中止。" }
        if summary.state == "waiting" {
            let command = "git push origin HEAD"
            messages.append(["id": "m-s-a2", "role": "assistant", "turn_id": "m-s-u1", "created_at": .string(created),
                             "seq": 2, "done": false,
                             "parts": [["type": "tool", "id": "call-s1", "title": .string(command), "kind": "execute",
                                        "status": "pending", "input": ["command": .string(command)]]]])
            control["pending"] = [["request_id": "req-s1", "message_id": "m-s-a2", "tool_call_id": "call-s1", "title": .string(command),
                                   "options": [["id": "allow", "name": "允许", "kind": "allow_once"],
                                               ["id": "always", "name": "本会话都允许", "kind": "allow_always"],
                                               ["id": "reject", "name": "拒绝", "kind": "reject_once"]]]]
        }
        return SessionState(session: session, messages: messages, control: control, hasMore: false)
    }

    private static func config(for agent: String) -> JSON {
        let models: JSON = agent == "codex"
            ? [["value": "gpt-5.5-codex", "name": "GPT-5.5 Codex"], ["value": "gpt-5.5", "name": "GPT-5.5"]]
            : [["value": "opus", "name": "Claude Opus"], ["value": "sonnet", "name": "Claude Sonnet"]]
        return [
            ["id": "model", "name": "模型", "category": "model", "current": models[0]?["value"] ?? "", "options": models],
            ["id": "mode", "name": "权限", "category": "mode", "current": "on-request",
             "options": [["value": "read-only", "name": "只读"], ["value": "on-request", "name": "按需批准"], ["value": "full-access", "name": "完全访问"]]],
        ]
    }

    // MARK: Stress (AA_POC_STRESS)

    private func stressSession(_ summary: Workspace.Session) -> JSON {
        ["id": .string(summary.id), "title": .string(summary.title), "agent": .string(summary.agent),
         "device": ["id": "dev-mbp", "name": "t4wefan 的 MacBook Pro"], "cwd": .string(summary.cwd), "branch": "stress/long-session",
         "created_at": .string(summary.updated_at), "updated_at": .string(summary.updated_at), "message_count": 0,
         "config": Self.config(for: "codex")]
    }

    /// `snapshot:n`: n finished items (whole turns) already in the session when it is opened.
    private func stressSnapshot(_ config: StressConfig, summary: Workspace.Session) -> SessionState {
        var state = SessionState(session: stressSession(summary), messages: [],
                                 control: ["state": "running", "steer": "native", "pending": [], "queued": [], "answered": []], hasMore: false)
        var content = StressContent(config: config, seed: 0xF111)
        var turn = 0
        while state.messages.count < config.snapshot {
            let user = content.user(turn)
            state.apply(["type": "message", "message": user], assignSeq: true, stamp: true)
            for step in content.turn(turn, userID: user["id"]?.string ?? "", approve: { false }) {
                state.apply(["type": "message", "message": StressContent.finished(step)], assignSeq: true, stamp: true)
            }
            turn += 1
        }
        stressPrefilledTurns = turn
        return state
    }

    private var stressPrefilledTurns = 0

    private final class Growing {
        var message: JSON
        let field: String
        let full: [Character]
        var shown = 0.0
        let perTick: Double
        let isTool: Bool
        var requestID: String?
        init(message: JSON, field: String, full: [Character], perTick: Double, isTool: Bool, requestID: String?) {
            self.message = message; self.field = field; self.full = full; self.perTick = perTick; self.isTool = isTool; self.requestID = requestID
        }
    }

    /// Reveals stress turns forever (until `items` items are finished): `parallel` items grow at once and each is pushed
    /// whole `hz` times a second. Approvals wait for an answer (AA_POC_AUTO_APPROVE_SECONDS answers them) while the
    /// other items keep growing.
    private func runStress(_ config: StressConfig, in source: Source) async {
        var content = StressContent(config: config)
        var turn = stressPrefilledTurns
        var queue: [StressContent.Step] = []
        var growing: [Growing] = []
        var finished = 0
        var stepCount = 0
        let interval = 1.0 / config.hz
        let started = Date()
        StressMetrics.shared.log(["k": "feed", "what": "start", "hz": .number(config.hz), "parallel": .number(Double(config.parallel)), "chars": .number(Double(config.chars)), "lines": .number(Double(config.lines)), "prefilled": .number(Double(source.state.messages.count))])
        var lastReport = Date()
        var pushedSinceReport = 0

        func pushCounted(_ event: JSON) {
            push(event, in: source)
            pushedSinceReport += 1
        }
        func setPending(_ change: (inout [JSON]) -> Void) {
            var control = source.state.control
            var pending = control["pending"]?.array ?? []
            change(&pending)
            control["pending"] = .array(pending)
            control["state"] = "running"
            pushCounted(["type": "control", "control": control])
        }

        while finished < config.items, !Task.isCancelled {
            // Start steps until `parallel` items are growing.
            while growing.count < config.parallel {
                if queue.isEmpty {
                    let user = content.user(turn)
                    pushCounted(["type": "message", "message": user])
                    finished += 1
                    queue = content.turn(turn, userID: user["id"]?.string ?? "") {
                        stepCount += 1
                        return config.approveEvery > 0 && stepCount % config.approveEvery == 0
                    }
                    turn += 1
                }
                let step = queue.removeFirst()
                switch step {
                case let .whole(message):
                    pushCounted(["type": "message", "message": message])
                    if message["done"]?.bool == true { finished += 1 }
                case let .text(message):
                    let full = Array(message["parts"]?[0]?["text"]?.string ?? "")
                    growing.append(Growing(message: message, field: "text", full: full, perTick: config.cps * interval, isTool: false, requestID: nil))
                case let .tool(message, pending):
                    let full = Array(message["parts"]?[0]?["output"]?.string ?? "")
                    var requestID: String?
                    if pending, let part = message["parts"]?[0], let messageID = message["id"]?.string {
                        let request = "req-\(messageID)"
                        requestID = request
                        var waiting = message
                        var waitingPart = part
                        waitingPart["status"] = "pending"
                        waitingPart["output"] = nil
                        waiting["parts"] = [waitingPart]
                        waiting["done"] = false
                        pushCounted(["type": "message", "message": waiting])
                        setPending { $0.append(["request_id": .string(request), "message_id": .string(messageID),
                            "tool_call_id": part["id"] ?? "", "title": part["title"] ?? "",
                            "options": [["id": "allow", "name": "允许", "kind": "allow_once"],
                                        ["id": "always", "name": "本会话都允许", "kind": "allow_always"],
                                        ["id": "reject", "name": "拒绝", "kind": "reject_once"]]]) }
                    }
                    growing.append(Growing(message: message, field: "output", full: full, perTick: config.lps * 70 * interval,
                                           isTool: true, requestID: requestID))
                }
            }
            // Grow each item one tick and push it whole.
            let pendingIDs = Set((source.state.control["pending"]?.array ?? []).compactMap { $0["request_id"]?.string })
            for item in growing {
                if let request = item.requestID {
                    if pendingIDs.contains(request) { continue }
                    item.requestID = nil
                }
                item.shown += item.perTick * Double.random(in: 0.8 ... 1.2, using: &rng)
                if Int(item.shown) < item.full.count {
                    var part = item.message["parts"]?[0] ?? [:]
                    part[item.field] = .string(String(item.full[0 ..< Int(item.shown)]))
                    if item.isTool { part["status"] = "in_progress" }
                    var partial = item.message
                    partial["parts"] = [part]
                    partial["done"] = false
                    pushCounted(["type": "message", "message": partial])
                } else {
                    pushCounted(["type": "message", "message": item.message])
                    finished += 1
                }
            }
            growing.removeAll { $0.requestID == nil && Int($0.shown) >= $0.full.count }
            if Date().timeIntervalSince(lastReport) >= 5 {
                StressMetrics.shared.log(["k": "feed", "finished": .number(Double(finished)), "items": .number(Double(source.state.messages.count)), "pushes": .number(Double(pushedSinceReport)), "growing": .number(Double(growing.count))])
                lastReport = Date()
                pushedSinceReport = 0
            }
            guard await Self.sleep(ms: interval * 1000) else { return }
        }
        var control = source.state.control
        control["state"] = "idle"
        push(["type": "control", "control": control], in: source)
        StressMetrics.shared.log(["k": "feed", "what": "done", "finished": .number(Double(finished)), "feedSeconds": .number(Date().timeIntervalSince(started).rounded())])
    }

    // MARK: Helpers

    private static func sleep(ms: Double) async -> Bool {
        do { try await Task.sleep(for: .milliseconds(Int(ms))); return true } catch { return false }
    }

    static func now() -> String { ISO8601DateFormatter().string(from: Date()) }
    static func token() -> String { String(UUID().uuidString.prefix(6)).lowercased() }
}

/// Deterministic jitter so screenshots of the same moment look alike between runs.
nonisolated struct SeededGenerator: RandomNumberGenerator {
    private var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
