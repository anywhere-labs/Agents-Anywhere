import Foundation

/// Slash-command rules shared with Web and Desktop
/// (web-next/src/components/session/runtime-command-model.ts). Only drafts
/// naming a catalog command run as commands; paths and prose stay messages.
struct SlashIntent: Equatable {
    let command: String
    let suffix: String
    let raw: String
    let multiline: Bool

    init?(_ raw: String) {
        let trimmed = raw.drop { $0.isWhitespace }
        guard trimmed.first == "/" else { return nil }
        let body = trimmed.dropFirst()
        let token = body.prefix { !$0.isWhitespace }
        command = token.lowercased()
        suffix = String(body.dropFirst(token.count))
        self.raw = raw
        multiline = raw.contains { $0 == "\n" || $0 == "\r" }
    }

    /// A slash token that could name a command; paths such as "/Users/me" never do.
    var isCommandLike: Bool {
        guard let first = command.unicodeScalars.first else { return true }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789_:.-")
        let leading = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789")
        return leading.contains(first) && command.unicodeScalars.allSatisfy { allowed.contains($0) }
    }
}

enum RuntimeCommandUI: Equatable {
    enum SelectorTarget: String { case model, reasoning, permission, collaborationMode }
    case execute(argumentHint: String?, acceptsMultiline: Bool, allowedStatuses: [String]?)
    case selector(SelectorTarget)
}

enum RuntimeCommandBlock: Equatable {
    case disabled, busy, readOnly, offline, unavailable
}

struct RuntimeCommandRequest: Equatable {
    let command: String
    let args: [String]
    let raw: String
}

struct RuntimeCommandOutcome: Equatable {
    enum State: String { case accepted, completed, unknown }
    let ok: Bool
    let state: State
    let message: String?
    let code: String?
}

extension V2RuntimeCommand {
    var takesArguments: Bool { acceptsArgs == true }

    /// Older catalogs predate `metadata.ui`: they keep plain execute behavior,
    /// without opting in to multiline or busy-state execution.
    var ui: RuntimeCommandUI? {
        guard case let .object(metadata)? = metadata, let value = metadata["ui"] else {
            return .execute(argumentHint: nil, acceptsMultiline: false, allowedStatuses: nil)
        }
        guard case let .object(ui) = value else { return nil }
        let kind = ui["kind"]?.stringValue
        if kind == "selector" {
            return ui["target"]?.stringValue.flatMap(RuntimeCommandUI.SelectorTarget.init(rawValue:)).map { .selector($0) }
        }
        guard kind == "execute" else { return nil }
        var statuses: [String]?
        if case let .array(items)? = ui["allowedStatuses"] {
            statuses = items.compactMap { if case let .string(value) = $0 { value } else { nil } }
        }
        var hint: String?
        if case let .string(value)? = ui["argumentHint"] { hint = value }
        return .execute(argumentHint: hint, acceptsMultiline: ui["acceptsMultiline"] == .bool(true), allowedStatuses: statuses)
    }

    var argumentHint: String? {
        if case let .execute(hint, _, _)? = ui { return hint }
        return nil
    }

    func matches(_ query: String) -> Bool {
        let normalized = query.lowercased()
        guard !normalized.isEmpty else { return true }
        return ([id, title] + aliases).contains { $0.lowercased().hasPrefix(normalized) }
    }

    func allowed(status: V2RuntimeStatus?) -> Bool {
        guard enabled, let ui else { return false }
        let value = (status ?? .unknown).rawValue
        if case let .execute(_, _, statuses) = ui, let statuses { return statuses.contains(value) }
        return value == "idle" || value == "error"
    }

    func block(status: V2RuntimeStatus?, capability: Bool, writable: Bool, online: Bool) -> RuntimeCommandBlock? {
        if !enabled { return .disabled }
        if !online { return .offline }
        if !capability { return .unavailable }
        if !writable { return .readOnly }
        return allowed(status: status) ? nil : .busy
    }

    func request(for intent: SlashIntent) -> RuntimeCommandRequest? {
        if intent.multiline { guard case .execute(_, true, _)? = ui else { return nil } }
        let suffix = intent.suffix.trimmingCharacters(in: .whitespacesAndNewlines)
        if !suffix.isEmpty && !takesArguments { return nil }
        let args: [String]
        if suffix.isEmpty { args = [] }
        else if case let .object(schema)? = argsSchema, schema["type"] == .string("string") {
            // String arguments are one free-form value, not an array of words.
            args = [intent.suffix.first?.isWhitespace == true ? String(intent.suffix.dropFirst()) : intent.suffix]
        } else {
            args = suffix.split(whereSeparator: \.isWhitespace).map(String.init)
        }
        return RuntimeCommandRequest(command: id, args: args, raw: intent.raw)
    }
}

extension Array where Element == V2RuntimeCommand {
    func exact(_ intent: SlashIntent) -> V2RuntimeCommand? {
        first { $0.id.lowercased() == intent.command || $0.aliases.contains { $0.lowercased() == intent.command } }
    }
}

extension RuntimeCommandOutcome {
    init(_ response: V2RuntimeCommandExecuteResponse) {
        var data: [String: JSONValue] = [:]
        if case let .object(value)? = response.result { data = value }
        let state: State
        if let raw = data["executionState"]?.stringValue, let value = State(rawValue: raw) { state = value }
        else if response.code == "command_outcome_unknown" { state = .unknown }
        else { state = response.ok ? .accepted : .completed }
        var text: String?
        if case let .string(value)? = data["text"] { text = value }
        self.init(ok: response.ok && state != .unknown, state: state,
            message: response.ok ? text ?? response.message : response.message ?? text, code: response.code)
    }

    /// Only definite 4xx rejections are known failures; anything else may have run.
    init(transportFailure error: Error) {
        let known = V2ClientFailure.isDefiniteWriteRejection(error)
        self.init(ok: false, state: known ? .completed : .unknown, message: error.localizedDescription,
            code: known ? "command_rejected" : "command_outcome_unknown")
    }
}
