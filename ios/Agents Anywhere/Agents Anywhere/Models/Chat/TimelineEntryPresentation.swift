import Foundation

/// Mirrors Web's session-tool-cards / session-timeline-entry parsing. Wire
/// payloads remain intact; presentation never guesses an executable action.
struct TimelineEntryPresentation: Hashable {
    enum Kind: Hashable { case tool, reasoning, artifact, compact, marker }
    let kind: Kind
    let title: String
    let symbol: String
    let command: String?
    let output: String?
    let input: JSONValue?
    let changes: [TimelineFileChange]
    let filePath: String?
    let externalURL: URL?
    let detail: JSONValue?

    init(item: V2TimelineItem, cwd: String?) {
        let raw = item.raw["content"] ?? .object([:])
        let wireKind = TimelineText.first(raw["kind"]) ?? (item.type == .fileChange ? "file_change" : item.type.rawValue)
        let toolInput = raw["input"]
        command = TimelineText.command(raw["command"]) ?? TimelineText.command(toolInput?["command"]) ?? TimelineText.command(toolInput?["cmd"])
        let rawChanges = raw["changes"]?.arrayValue?.filter { if case .object = $0 { return true }; return false } ?? []
        changes = (rawChanges.isEmpty && wireKind == "file_change" && TimelineText.path(raw) != nil ? [raw] : rawChanges)
            .enumerated().map { TimelineFileChange(raw: $0.element, index: $0.offset, cwd: cwd) }
        output = changes.isEmpty ? TimelineText.first(raw["output"], raw["outputPreview"], raw["outputText"], raw["error"])
            ?? raw["output"].flatMap { $0 == .null ? nil : $0.formattedJSON } : nil
        input = command == nil && changes.isEmpty ? toolInput : nil
        filePath = TimelineText.path(raw)
        externalURL = TimelineText.first(raw["url"], raw["openUrl"]).flatMap(URL.init(string:))
            .flatMap { ["https", "http"].contains($0.scheme?.lowercased() ?? "") ? $0 : nil }
        if item.isReasoning {
            kind = .reasoning; symbol = "sparkles"
            let text = TimelineText.reasoning(raw)
            if let summary = TimelineText.inlineSummary(text), !summary.isEmpty { title = "思考：\(summary)" }
            else { title = item.status.isActive ? "正在思考" : "思考过程" }
            detail = nil
        } else if wireKind == "compact" && [.system, .marker].contains(item.type) {
            kind = .compact; symbol = "line.3.horizontal.decrease"
            let active = ["started", "running", "inProgress"].contains(raw["state"]?.stringValue ?? "") || item.status.isActive
            title = item.status == .failed || raw["state"] == .string("failed") ? "上下文压缩失败" : active ? "正在压缩上下文" : "上下文已压缩"
            detail = item.status == .failed ? raw : nil
        } else if item.type == .tool || wireKind == "file_change" || item.type == .fileChange {
            kind = .tool
            symbol = ["command": "terminal", "file_change": "doc.badge.gearshape", "agent_call": "person.2", "web_search": "magnifyingglass", "mcp": "puzzlepiece.extension"][wireKind] ?? "hammer"
            let targetPath = filePath ?? TimelineText.first(toolInput?["file_path"], toolInput?["notebook_path"], toolInput?["path"])
            let target = targetPath.map { TimelineText.displayPath($0, cwd: cwd) }
                ?? TimelineText.first(raw["query"], toolInput?["query"], raw["url"], toolInput?["url"])
            if wireKind == "file_change" {
                let added = !changes.isEmpty && changes.allSatisfy { $0.action == .add }
                let path = changes.count == 1 ? changes[0].displayPath : nil
                title = (added ? "已创建" : "已修改") + (path.map { $0.count <= 60 ? " \($0)" : "文件" } ?? "文件")
            } else if wireKind == "command" { title = "执行 \(command ?? "命令")" }
            else if wireKind == "web_search" { title = "搜索 \(TimelineText.first(raw["query"], toolInput?["query"]) ?? "网页")" }
            else if wireKind == "mcp" {
                title = "\(TimelineText.first(raw["server"], toolInput?["server"]) ?? "MCP") / \(TimelineText.first(raw["tool"], toolInput?["tool"]) ?? "工具")"
            } else if wireKind == "agent_call" {
                let action = ["invoke": "调用 Agent", "spawn": "创建 Agent", "send_input": "向 Agent 发送消息", "resume": "恢复 Agent", "wait": "等待 Agent", "close": "结束 Agent"][raw["action"]?.stringValue ?? ""] ?? "Agent 调用"
                title = action + (TimelineText.first(raw["description"], raw["title"]).map { "：\($0)" } ?? "")
            } else {
                title = [TimelineText.first(raw["toolName"], raw["name"], raw["tool"], raw["title"]), target].compactMap { $0 }.joined(separator: " ").nonempty ?? wireKind
            }
            detail = nil
        } else if item.type == .artifact {
            kind = .artifact; symbol = "doc.richtext"
            title = filePath.map { TimelineText.displayPath($0, cwd: cwd) } ?? TimelineText.first(raw["title"], raw["name"]) ?? wireKind
            detail = raw
        } else {
            kind = .marker; symbol = item.status.isFailure || wireKind == "error" ? "exclamationmark.circle" : "clock"
            let message = item.type == .marker ? TimelineText.first(raw["label"], raw["title"])
                : TimelineText.first(raw["text"], raw["message"], raw["rawText"], raw["details"]?["error"]?["message"])
            title = message ?? TimelineText.first(raw["title"]) ?? wireKind
            if case var .object(fields) = raw {
                for key in ["kind", "text", "message", "rawText", "label", "title"] { fields.removeValue(forKey: key) }
                detail = fields.isEmpty ? nil : .object(fields)
            } else { detail = raw == .null ? nil : raw }
        }
    }
}

struct TimelineFileChange: Hashable, Identifiable {
    enum Action: String { case add, modify, delete, rename, unknown
        var label: String { switch self { case .add: "新增"; case .modify: "修改"; case .delete: "删除"; case .rename: "重命名"; case .unknown: "变更" } }
    }
    let id: String
    let path: String?
    let displayPath: String
    let action: Action
    let code: String?
    let diff: String?

    init(raw: JSONValue, index: Int, cwd: String?) {
        path = TimelineText.path(raw)
        displayPath = path.map { TimelineText.displayPath($0, cwd: cwd) } ?? "未知文件"
        id = "\(index):\(path ?? "")"
        let value = TimelineText.first(raw["kind"]?["type"], raw["kind"], raw["action"], raw["type"], raw["status"])?.lowercased() ?? ""
        switch value {
        case "add", "added", "create", "created": action = .add
        case "delete", "deleted", "remove", "removed": action = .delete
        case "rename", "renamed", "move", "moved": action = .rename
        case "modify", "modified", "change", "changed", "edit", "edited": action = .modify
        default: action = .unknown
        }
        code = TimelineText.first(raw["diff"], raw["patch"])
        if let code {
            if TimelineDiff.isUnified(code) { diff = code }
            else if action == .add || action == .delete {
                let sign = action == .add ? "+" : "-"
                diff = code.components(separatedBy: "\n").map { sign + $0 }.joined(separator: "\n")
            } else { diff = nil }
        } else { diff = nil }
    }
}

nonisolated enum TimelineText {
    static func first(_ values: JSONValue?...) -> String? { values.compactMap { $0?.stringValue }.first { !$0.isEmpty } }
    static func command(_ value: JSONValue?) -> String? {
        if let text = value?.stringValue { return text.nonempty }
        if let parts = value?.arrayValue { return parts.map { $0.stringValue ?? $0.formattedJSON }.joined(separator: " ").nonempty }
        return nil
    }
    static func path(_ raw: JSONValue) -> String? { first(raw["path"], raw["filePath"], raw["file"], raw["uri"]) }
    static func displayPath(_ path: String, cwd: String?) -> String {
        guard let cwd, !cwd.isEmpty else { return path }
        let normalized = path.replacingOccurrences(of: "\\", with: "/")
        let root = cwd.replacingOccurrences(of: "\\", with: "/").replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        if normalized == root { return "." }
        return normalized.hasPrefix(root + "/") ? String(normalized.dropFirst(root.count + 1)) : path
    }
    static func message(_ value: String) -> String {
        let ends = ["\n\n[Attached file: ", "\n\n[Failed to load attachment ", "\n\n[Attachments dropped "]
            .compactMap { value.range(of: $0)?.lowerBound }
        return ends.min().map { String(value[..<$0]).replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression) } ?? value
    }
    static func reasoning(_ raw: JSONValue) -> String {
        let summaries = raw["summaries"]?.arrayValue?.compactMap { first($0["text"]) } ?? []
        return summaries.isEmpty ? first(raw["rawText"], raw["text"], raw["summary"]) ?? "" : summaries.joined(separator: "\n\n")
    }
    static func inlineSummary(_ text: String) -> String? {
        guard !text.contains("\n"), !text.contains("\r") else { return nil }
        let plain = text.replacingOccurrences(of: "!?\\[([^\\]]*)\\]\\([^)]+\\)", with: "$1", options: .regularExpression)
            .replacingOccurrences(of: "[`*_~#>]", with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        return plain.count <= 80 ? plain.nonempty : nil
    }
}

extension V2TimelineItem {
    var isReasoning: Bool { type == .reasoning || type == .system && raw["content"]?["kind"] == .string("reasoning") }
    var isVisibleInChat: Bool {
        guard status != .hidden, ![.turnStart, .turnEnd].contains(type) else { return false }
        if type == .artifact && raw["content"]?["kind"] == .string("diff") { return false }
        if type == .message, source["runtime"] == .string("claude") {
            let text = displayText.trimmingCharacters(in: .whitespacesAndNewlines)
            if role == .user && ["[Request interrupted by user]", "[Request interrupted by user for tool use]"].contains(text) { return false }
            if role == .assistant && text == "No response requested." { return false }
        }
        return true
    }
}
extension V2TimelineItemStatus {
    var isActive: Bool { [.pending, .running, .waitingApproval].contains(self) }
    var isFailure: Bool { [.failed, .cancelled, .interrupted].contains(self) }
    var label: String {
        switch self {
        case .pending: "等待中"; case .running: "进行中"; case .waitingApproval: "等待回应"
        case .done: "已完成"; case .failed: "失败"; case .cancelled: "已取消"; case .interrupted: "已中断"
        case .hidden: "已隐藏"; case .unknown: "未知状态"
        }
    }
}
extension JSONValue {
    nonisolated var formattedJSON: String {
        if case let .string(text) = self { return text }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
}
private extension String { nonisolated var nonempty: String? { isEmpty ? nil : self } }
