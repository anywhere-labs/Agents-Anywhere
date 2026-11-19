import Foundation

/// The sidebar data (`watch_list` in v3), decoded from Fixtures/workspace.json.
nonisolated struct Workspace: Decodable, Sendable {
    struct Account: Decodable, Sendable { let name: String; let email: String }
    struct Device: Decodable, Identifiable, Sendable {
        let id: String
        let name: String
        let presence: String
        let platform: String
        var isOnline: Bool { presence == "online" }
    }
    struct Project: Decodable, Identifiable, Sendable {
        let device_id: String
        let cwd: String
        let name: String
        var remoteId: String? = nil
        var id: String { "\(device_id):\(cwd)" }
    }
    struct Session: Decodable, Identifiable, Sendable {
        let id: String
        var title: String
        let agent: String
        let device_id: String
        let cwd: String
        let state: String
        var unread: Bool
        var pinned: Bool
        let updated_at: String
    }

    let account: Account
    let devices: [Device]
    let projects: [Project]
    var sessions: [Session]
}

/// Bundled fixtures. `sync-fixtures.sh` copies them from v3poc/fixtures into AAv3PoC/Fixtures.
nonisolated enum Fixtures {
    static func data(_ name: String) -> Data? {
        guard let url = Bundle.main.url(forResource: name, withExtension: "json") else { return nil }
        return try? Data(contentsOf: url)
    }

    static func workspace() -> Workspace {
        guard let data = data("workspace"), let workspace = try? JSONDecoder().decode(Workspace.self, from: data) else {
            return Workspace(account: .init(name: "demo", email: ""), devices: [], projects: [], sessions: [])
        }
        return workspace
    }

    /// `{ account, snapshot, script, reply }`.
    static func demo() -> JSON? {
        guard let data = data("session-demo") else { return nil }
        return try? JSON.decode(data)
    }
}

/// Session state as the shell shows it (toolbar status, sidebar indicator).
nonisolated enum SessionActivity: Equatable, Sendable {
    case idle, running, waiting, error, disconnected

    init(summaryState: String) {
        switch summaryState {
        case "running": self = .running
        case "waiting": self = .waiting
        case "error": self = .error
        case "disconnected": self = .disconnected
        default: self = .idle
        }
    }

    /// From a v3 `Control`: a pending request means someone has to answer.
    init(control: JSON) {
        if control["pending"]?.array?.isEmpty == false { self = .waiting; return }
        self = .init(summaryState: control["state"]?.string ?? "idle")
    }
}

extension Workspace.Session {
    var agentLabel: String {
        switch agent {
        case "codex": "Codex"
        case "claude": "Claude Code"
        case "dsh": "DeepSeek Harness"
        default: agent
        }
    }
}
