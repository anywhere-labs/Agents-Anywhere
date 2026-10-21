import Foundation
import Testing
@testable import ClientCore

@Suite @MainActor struct RuntimeCommandTests {
    private func command(_ id: String = "compact", aliases: [String] = [], enabled: Bool = true, acceptsArgs: Bool = false,
                         argsSchema: [String: Any]? = nil, ui: Any? = nil) throws -> V2RuntimeCommand {
        var value: [String: Any] = ["id": id, "title": id.capitalized, "aliases": aliases, "scope": "session",
                                    "enabled": enabled, "acceptsArgs": acceptsArgs]
        if let argsSchema { value["argsSchema"] = argsSchema }
        if let ui { value["metadata"] = ["ui": ui] }
        return try decode(value)
    }

    private func response(ok: Bool, code: String? = nil, message: String? = nil, result: [String: Any]? = nil) throws -> V2RuntimeCommandExecuteResponse {
        var value: [String: Any] = ["ok": ok, "serverTime": "2026-01-01T00:00:00Z"]
        if let code { value["code"] = code }
        if let message { value["message"] = message }
        if let result { value["result"] = result }
        return try decode(value)
    }

    @Test func onlyCommandLikeSlashTokensAreIntents() {
        #expect(SlashIntent("hello") == nil)
        let intent = SlashIntent("  /Compact now")
        #expect(intent?.command == "compact")
        #expect(intent?.suffix == " now")
        #expect(intent?.isCommandLike == true)
        #expect(SlashIntent("/")?.isCommandLike == true)
        #expect(SlashIntent("/Users/me/file")?.isCommandLike == false)
        #expect(SlashIntent("/goal\nnext")?.multiline == true)
    }

    @Test func matchingUsesIdTitleAndAliasPrefixes() throws {
        let compact = try command(aliases: ["summarize"])
        #expect(compact.matches(""))
        #expect(compact.matches("COM"))
        #expect(compact.matches("sum"))
        #expect(!compact.matches("x"))
        #expect([compact].exact(SlashIntent("/summarize")!) == compact)
        #expect([compact].exact(SlashIntent("/sum")!) == nil)
    }

    @Test func legacyCatalogsExecuteOnlyWhileIdle() throws {
        let legacy = try command()
        #expect(legacy.ui == .execute(argumentHint: nil, acceptsMultiline: false, allowedStatuses: nil))
        #expect(legacy.allowed(status: .idle))
        #expect(legacy.allowed(status: .error))
        #expect(!legacy.allowed(status: .running))
        let busy = try command(ui: ["kind": "execute", "allowedStatuses": ["running"], "argumentHint": "<goal>"])
        #expect(busy.allowed(status: .running))
        #expect(!busy.allowed(status: .idle))
        #expect(busy.argumentHint == "<goal>")
        #expect(try command(ui: ["kind": "selector", "target": "model"]).ui == .selector(.model))
        #expect(try command(ui: ["kind": "future"]).ui == nil)
    }

    @Test func blocksExplainWhyACommandCannotRun() throws {
        let item = try command()
        #expect(try command(enabled: false).block(status: .idle, capability: true, writable: true, online: true) == .disabled)
        #expect(item.block(status: .idle, capability: true, writable: true, online: false) == .offline)
        #expect(item.block(status: .idle, capability: false, writable: true, online: true) == .unavailable)
        #expect(item.block(status: .idle, capability: true, writable: false, online: true) == .readOnly)
        #expect(item.block(status: .running, capability: true, writable: true, online: true) == .busy)
        #expect(item.block(status: .idle, capability: true, writable: true, online: true) == nil)
    }

    @Test func requestsKeepRawTextAndValidateArguments() throws {
        #expect(try command().request(for: SlashIntent("/compact")!) == RuntimeCommandRequest(command: "compact", args: [], raw: "/compact"))
        #expect(try command().request(for: SlashIntent("/compact now")!) == nil)
        let words = try command("goal", acceptsArgs: true)
        #expect(words.request(for: SlashIntent("/goal  a  b")!)?.args == ["a", "b"])
        let text = try command("goal", acceptsArgs: true, argsSchema: ["type": "string"])
        #expect(text.request(for: SlashIntent("/goal  a  b")!)?.args == [" a  b"])
        #expect(text.request(for: SlashIntent("/goal a\nb")!) == nil)
        let multiline = try command("goal", acceptsArgs: true, argsSchema: ["type": "string"], ui: ["kind": "execute", "acceptsMultiline": true])
        #expect(multiline.request(for: SlashIntent("/goal a\nb")!)?.args == ["a\nb"])
    }

    @Test func outcomesDistinguishAcceptedCompletedAndUnknown() throws {
        let completed = RuntimeCommandOutcome(try response(ok: true, message: "done", result: ["executionState": "completed", "text": "native"]))
        #expect(completed == RuntimeCommandOutcome(ok: true, state: .completed, message: "native", code: nil))
        #expect(RuntimeCommandOutcome(try response(ok: true, message: "queued")).state == .accepted)
        let unknown = RuntimeCommandOutcome(try response(ok: true, result: ["executionState": "unknown"]))
        #expect(!unknown.ok)
        let rejected = RuntimeCommandOutcome(try response(ok: false, code: "busy", message: "Busy"))
        #expect(rejected == RuntimeCommandOutcome(ok: false, state: .completed, message: "Busy", code: "busy"))
        #expect(RuntimeCommandOutcome(transportFailure: HTTPError.server(statusCode: 409, message: "no")).state == .completed)
        #expect(RuntimeCommandOutcome(transportFailure: URLError(.timedOut)).state == .unknown)
    }
}
