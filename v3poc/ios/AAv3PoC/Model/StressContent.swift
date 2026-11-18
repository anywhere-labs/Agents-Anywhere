import Foundation

/// `AA_POC_STRESS=items:3000,chars:3000,hz:30,parallel:3,snapshot:0,lines:2000,difflines:300,approve:40`
/// A fixture-free `s-stress` session that never stops producing: long Markdown (headings, lists, code in several
/// languages, wide tables, quotes, a little math and mermaid), thinking, tools (execute with thousands of terminal lines,
/// read with long files, search, edit with long diffs, failures), a plan updated often, subagents with steps, approvals,
/// user messages with attachments. Items grow and are pushed whole, as the protocol says, `hz` times a second, with
/// `parallel` of them growing at once. `snapshot:n` starts the session with n finished items already in it.
nonisolated struct StressConfig: Sendable {
    var items = 3000
    var chars = 3000
    var hz = 30.0
    var parallel = 3
    var snapshot = 0
    var lines = 2000
    var diffLines = 300
    /// One approval every n items (0: none).
    var approveEvery = 40
    /// Text growth, characters per second per item.
    var cps = 1500.0
    /// Terminal / file growth, lines per second per item.
    var lps = 150.0

    static let sessionID = "s-stress"

    static let current: StressConfig? = {
        guard let spec = ProcessInfo.processInfo.environment["AA_POC_STRESS"], !spec.isEmpty else { return nil }
        var config = StressConfig()
        for pair in spec.split(separator: ",") {
            let kv = pair.split(separator: ":", maxSplits: 1).map(String.init)
            guard kv.count == 2, let value = Double(kv[1]) else { continue }
            switch kv[0] {
            case "items": config.items = Int(value)
            case "chars": config.chars = Int(value)
            case "hz": config.hz = max(0.5, value)
            case "parallel": config.parallel = max(1, Int(value))
            case "snapshot": config.snapshot = Int(value)
            case "lines": config.lines = Int(value)
            case "difflines": config.diffLines = Int(value)
            case "approve": config.approveEvery = Int(value)
            case "cps": config.cps = value
            case "lps": config.lps = value
            default: break
            }
        }
        return config
    }()

    var summary: Workspace.Session {
        Workspace.Session(id: Self.sessionID, title: "压力测试：长会话高频推送", agent: "codex", device_id: "dev-mbp",
                          cwd: "~/code/github/Agents-Anywhere", state: "running", unread: false, pinned: true,
                          updated_at: "2026-11-17T10:00:00Z")
    }
}

/// Deterministic content for the stress session. Every item is built whole up front; the feed then reveals it.
nonisolated struct StressContent {
    let config: StressConfig
    private var rng: SeededGenerator

    init(config: StressConfig, seed: UInt64 = 0x5EED) {
        self.config = config
        rng = SeededGenerator(seed: seed)
    }

    /// What one step of the agent looks like before it is revealed.
    enum Step {
        /// parts[0].text grows.
        case text(JSON)
        /// parts[0].output (a string) grows; `pending` asks for approval first.
        case tool(JSON, pending: Bool)
        /// Pushed whole (plan update, edit with diffs, subagent part, user message).
        case whole(JSON)
    }

    static let words = ["会话", "同步", "渲染", "整条替换", "推送", "连接器", "审批", "快照", "缓存", "WebView", "React", "Markdown",
                        "Timeline", "seq", "control", "watch", "队列", "回压", "增量", "高亮", "虚拟化", "布局", "滚动", "内存"]

    mutating func sentence(_ count: Int) -> String {
        (0 ..< count).map { _ in Self.words[Int.random(in: 0 ..< Self.words.count, using: &rng)] }.joined(separator: " ") + "。"
    }

    mutating func markdown(chars: Int, index: Int) -> String {
        var out = "## 第 \(index) 段分析\n\n"
        var block = 0
        while out.count < chars {
            switch block % 9 {
            case 0: out += sentence(24) + " 包含 `inline_code_\(block)` 和 **加粗** 以及 *斜体*。\n\n"
            case 1: out += (1 ... 6).map { "- 第 \($0) 点：" + sentence(10) }.joined(separator: "\n") + "\n\n"
            case 2:
                let lang = ["swift", "typescript", "python", "go", "rust", "sql"][index % 6]
                out += "```\(lang)\n" + (0 ..< 40).map { Self.codeLine(lang, $0) }.joined(separator: "\n") + "\n```\n\n"
            case 3:
                out += "| 列 A | 列 B | 列 C | 列 D | 列 E | 列 F | 列 G | 列 H |\n|---|---|---|---|---|---|---|---|\n"
                out += (0 ..< 12).map { r in "| r\(r) " + (0 ..< 7).map { "| 单元格内容 \(r)-\($0) 比较长一些" }.joined() + " |" }.joined(separator: "\n") + "\n\n"
            case 4: out += "> " + sentence(30) + "\n> " + sentence(12) + "\n\n"
            case 5: out += "### 小节 \(block)\n\n1. " + sentence(8) + "\n2. " + sentence(9) + "\n3. " + sentence(7) + "\n\n"
            case 6: out += index % 5 == 0 ? "$$\n\\sum_{i=0}^{n} x_i^2 = \\int_0^1 f(t)\\,dt\n$$\n\n" : sentence(20) + "\n\n"
            case 7: out += index % 7 == 0 ? "```mermaid\ngraph TD\n  A[watch] --> B[snapshot]\n  B --> C[message]\n  C --> D[render]\n```\n\n" : sentence(16) + "\n\n"
            default: out += sentence(40) + "\n\n"
            }
            block += 1
        }
        return out
    }

    static func codeLine(_ lang: String, _ n: Int) -> String {
        switch lang {
        case "swift": "    let value\(n) = try await client.watch(id: \"s-\(n)\").first { $0.type == .snapshot } // \(n)"
        case "typescript": "  const item\(n): Message = { id: `m-\(n)`, seq: \(n), done: false, parts: [{ type: 'text', text: '' }] }"
        case "python": "    result_\(n) = await store.get(session_id=\"s-\(n)\", limit=\(n * 3))  # noqa: E501"
        case "go": "\tif err := router.Forward(ctx, frame\(n)); err != nil { return fmt.Errorf(\"forward %d: %w\", \(n), err) }"
        case "rust": "    let frame_\(n) = codec.decode(&mut buf).map_err(|e| Error::Frame(\(n), e))?;"
        default: "SELECT id, seq, payload FROM items WHERE session_id = 's-\(n)' AND seq > \(n) ORDER BY seq LIMIT 100;"
        }
    }

    static func terminalLine(_ n: Int) -> String {
        switch n % 5 {
        case 0: "tests/test_module_\(n / 5).py::test_case_\(n) PASSED                                    [\(n % 100)%]"
        case 1: "  Compiling crate-\(n) v0.\(n % 10).\(n % 7) (/srv/build/crate-\(n))"
        case 2: "2026-11-17T10:\(String(format: "%02d", n % 60)):00Z INFO  router: forwarded frame seq=\(n) bytes=\(n * 37 % 9000)"
        case 3: "\u{1B}[32mok\u{1B}[0m   step \(n): applied migration v2_\(n % 50) in \(n % 300)ms"
        default: "warning: unused variable `tmp_\(n)` --> src/lib.rs:\(n):\(n % 80)"
        }
    }

    static func fileLines(_ count: Int, offset: Int) -> String {
        (0 ..< count).map { "\(offset + $0 + 1)\t" + codeLine(["python", "swift", "typescript"][$0 % 3], offset + $0) }.joined(separator: "\n")
    }

    /// The steps of one turn, after its user message. `base` makes ids unique.
    mutating func turn(_ turnIndex: Int, userID: String, approve: () -> Bool) -> [Step] {
        let id = { (n: Int) in "m-st\(turnIndex)-\(n)" }
        let assistant = { (n: Int, part: JSON) -> JSON in
            ["id": .string(id(n)), "role": "assistant", "turn_id": .string(userID), "created_at": "2026-11-17T10:00:00Z",
             "done": true, "parts": [part]]
        }
        var steps: [Step] = []
        var n = 0
        func next() -> Int { n += 1; return n }
        steps.append(.text(assistant(next(), ["type": "thinking", "text": .string(sentence(60) + "\n\n" + sentence(80))])))
        let planID = next()
        let entries = (0 ..< 5).map { "步骤 \($0 + 1)：" + ["读取相关代码", "修改同步逻辑", "补充测试", "跑测试", "整理结论"][$0] }
        func plan(_ doneCount: Int, final: Bool) -> JSON {
            var message = assistant(planID, ["type": "plan", "entries": .array(entries.enumerated().map { index, text in
                ["content": .string(text), "status": .string(index < doneCount ? "completed" : index == doneCount ? "in_progress" : "pending")]
            })])
            message["done"] = .bool(final)
            return message
        }
        steps.append(.whole(plan(0, final: false)))
        let kinds = ["execute", "read", "text", "search", "edit", "execute-fail", "text", "subagent"]
        for (k, kind) in kinds.enumerated() {
            let callID = "call-st\(turnIndex)-\(k)"
            switch kind {
            case "execute", "execute-fail":
                let failed = kind == "execute-fail"
                let output = (0 ..< (failed ? config.lines / 4 : config.lines)).map { Self.terminalLine($0 + k * 7) }.joined(separator: "\n")
                    + (failed ? "\nError: process exited with code 1" : "")
                let command = failed ? "uv run pytest tests/ -q -x" : "cargo test --workspace -- --nocapture"
                steps.append(.tool(assistant(next(), ["type": "tool", "id": .string(callID), "title": .string(command), "kind": "execute",
                    "status": .string(failed ? "failed" : "completed"), "input": ["command": .string(command)], "output": .string(output)]),
                    pending: approve()))
            case "read":
                let path = "server/agent_server/services/module_\(turnIndex % 40).py"
                steps.append(.tool(assistant(next(), ["type": "tool", "id": .string(callID), "title": .string("Read \(path)"), "kind": "read",
                    "status": "completed", "input": ["path": .string(path)], "output": .string(Self.fileLines(config.lines / 2, offset: turnIndex)),
                    "locations": [["path": .string(path), "line": 1]]]), pending: false))
            case "search":
                let output = (0 ..< 200).map { "services/module_\($0 % 40).py:\($0 * 3 + 1): state.unread = state.latest_seq > \($0)" }.joined(separator: "\n")
                steps.append(.tool(assistant(next(), ["type": "tool", "id": .string(callID), "title": "rg -n \"unread\" server/", "kind": "search",
                    "status": "completed", "input": ["pattern": "unread"], "output": .string(output)]), pending: false))
            case "edit":
                let path = "server/agent_server/services/module_\(turnIndex % 40).py"
                let old = Self.fileLines(config.diffLines, offset: turnIndex)
                let new = Self.fileLines(config.diffLines, offset: turnIndex + 1)
                steps.append(.whole(assistant(next(), ["type": "tool", "id": .string(callID), "title": .string("Edit \(path)"), "kind": "edit",
                    "status": "completed", "input": ["path": .string(path)],
                    "diffs": [["path": .string(path), "old_text": .string(old), "new_text": .string(new)]]])))
                steps.append(.whole(plan(2, final: false)))
            case "subagent":
                let partID = "sub-st\(turnIndex)"
                var sub = assistant(next(), ["type": "subagent", "id": .string(partID), "title": "检查其他调用方", "description": "在代码库里找出所有写未读状态的地方",
                    "agent_type": "explore", "status": "running", "started_at": "2026-11-17T10:00:00Z", "tool_count": 4, "parts": []])
                sub["done"] = false
                steps.append(.whole(sub))
                for s in 0 ..< 4 {
                    var child = assistant(next(), s % 2 == 0
                        ? ["type": "tool", "id": .string("\(callID)-\(s)"), "title": .string("Read services/module_\(s).py"), "kind": "read",
                           "status": "completed", "output": .string(Self.fileLines(80, offset: s))]
                        : ["type": "text", "text": .string(sentence(40))])
                    child["subagent_id"] = .string(partID)
                    steps.append(s % 2 == 0 ? .tool(child, pending: false) : .text(child))
                }
                var finished = sub
                finished["done"] = true
                finished["parts"] = [["type": "subagent", "id": .string(partID), "title": "检查其他调用方", "agent_type": "explore",
                                      "status": "completed", "started_at": "2026-11-17T10:00:00Z", "ended_at": "2026-11-17T10:00:09Z",
                                      "tool_count": 4, "parts": [], "result": .string(sentence(30))]]
                steps.append(.whole(finished))
            default:
                steps.append(.text(assistant(next(), ["type": "text", "text": .string(markdown(chars: config.chars, index: turnIndex * 10 + k))])))
            }
        }
        steps.append(.whole(plan(5, final: true)))
        return steps
    }

    /// The person's message that starts a turn; every third one carries an image and a file.
    func user(_ turnIndex: Int) -> JSON {
        var parts: [JSON] = [["type": "text", "text": .string("第 \(turnIndex) 轮：继续，把剩下的步骤做完，顺便把测试补齐。")]]
        if turnIndex % 3 == 0 {
            parts.append(["type": "image", "path": .string("/tmp/shot-\(turnIndex).png"), "name": .string("截图-\(turnIndex).png"), "mime": "image/png", "size": 182_000])
            parts.append(["type": "file", "path": .string("/tmp/log-\(turnIndex).txt"), "name": .string("日志-\(turnIndex).txt"), "mime": "text/plain", "size": 48_000])
        }
        return ["id": .string("m-st\(turnIndex)-u"), "role": "user", "created_at": "2026-11-17T10:00:00Z", "done": true, "rewindable": true,
                "parts": .array(parts)]
    }

    /// A finished item as it ends up after its stream (for prefilled snapshots).
    static func finished(_ step: Step) -> JSON {
        switch step {
        case let .text(message), let .whole(message): message
        case let .tool(message, _): message
        }
    }
}
