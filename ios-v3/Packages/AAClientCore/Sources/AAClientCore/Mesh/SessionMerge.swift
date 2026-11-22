// Multi-device session list merging. Rules and shared fixtures: `contracts/aa-v3/1.0/README.md` and
// `contracts/aa-v3/1.0/fixtures/session-merge.json` (Web, Desktop, iOS and Android must all pass them).
//
//   1. A device's `ok` result replaces that device's whole slice.
//   2. The control plane's `encrypted` marker never overwrites what the client fetched itself.
//   3. `offline` / `timeout` / `error` keep the cached slice, marked stale.
//   4. A locally pinned end-to-end device never accepts a plaintext control-plane result (`e2e_required_locally`).
//   5. Order: pinned first, then `updated_at` descending, then `device_id`, then `id` ascending.

import Foundation

public enum MergeSource: String, Sendable {
    case controlPlane = "control_plane"
    case clientTunnel = "client_tunnel"
}

public struct DeviceListState: Sendable, Hashable, Codable {
    /// `ok` | `cached` | `offline` | `timeout` | `error` | `encrypted`.
    public var status: String
    public var stale: Bool
    public var errorCode: String?

    enum CodingKeys: String, CodingKey {
        case status, stale
        case errorCode = "error_code"
    }

    public init(status: String, stale: Bool, errorCode: String? = nil) {
        self.status = status
        self.stale = stale
        self.errorCode = errorCode
    }
}

public struct SessionMerger: Sendable {
    public private(set) var slices: [String: SessionList] = [:]
    public private(set) var states: [String: DeviceListState] = [:]
    /// Devices pinned for end-to-end encryption on this client.
    public var localE2EE: Set<String>

    public init(cache: [String: SessionList] = [:], localE2EE: Set<String> = []) {
        self.localE2EE = localE2EE
        for (deviceID, list) in cache {
            slices[deviceID] = list
            states[deviceID] = DeviceListState(status: "cached", stale: true)
        }
    }

    public mutating func apply(_ result: DeviceSessionResult, from source: MergeSource) {
        let deviceID = result.deviceID
        if source == .controlPlane, localE2EE.contains(deviceID) {
            if result.status == "encrypted" {
                if states[deviceID] == nil { states[deviceID] = DeviceListState(status: "encrypted", stale: true) }
            } else {
                states[deviceID] = DeviceListState(status: "error", stale: true, errorCode: PairingErrorCode.e2eRequiredLocally.rawValue)
            }
            return
        }
        switch result.status {
        case "ok":
            slices[deviceID] = result.value ?? SessionList()
            states[deviceID] = DeviceListState(status: "ok", stale: false)
        case "encrypted":
            if states[deviceID] == nil { states[deviceID] = DeviceListState(status: "encrypted", stale: true) }
        default:
            states[deviceID] = DeviceListState(status: result.status, stale: true, errorCode: result.error?.code)
        }
    }

    public mutating func removeDevice(_ deviceID: String) {
        slices.removeValue(forKey: deviceID)
        states.removeValue(forKey: deviceID)
    }

    public var sessions: [SessionSummary] {
        Self.sorted(slices.values.flatMap(\.sessions))
    }

    public static func sorted(_ sessions: [SessionSummary]) -> [SessionSummary] {
        sessions.sorted { a, b in
            if a.pinned != b.pinned { return a.pinned }
            let ta = ISO8601.parse(a.updatedAt)?.timeIntervalSince1970 ?? 0
            let tb = ISO8601.parse(b.updatedAt)?.timeIntervalSince1970 ?? 0
            if ta != tb { return ta > tb }
            if a.deviceID != b.deviceID { return a.deviceID < b.deviceID }
            return a.id < b.id
        }
    }
}

/// Agent → project → conversations, as the device page lists them.
public struct AgentGroup: Sendable, Hashable, Identifiable {
    public struct Project: Sendable, Hashable, Identifiable {
        public var cwd: String
        public var name: String
        public var sessions: [SessionSummary]
        public var id: String { cwd }
    }

    public var agent: String
    public var projects: [Project]
    public var id: String { agent }

    /// Group a device's sessions; agents ordered by their newest conversation, projects likewise.
    public static func group(_ sessions: [SessionSummary]) -> [AgentGroup] {
        let sorted = SessionMerger.sorted(sessions)
        var agents: [String] = []
        var byAgent: [String: [SessionSummary]] = [:]
        for session in sorted {
            if byAgent[session.agent] == nil { agents.append(session.agent) }
            byAgent[session.agent, default: []].append(session)
        }
        return agents.map { agent in
            var cwds: [String] = []
            var byCwd: [String: [SessionSummary]] = [:]
            for session in byAgent[agent] ?? [] {
                if byCwd[session.cwd] == nil { cwds.append(session.cwd) }
                byCwd[session.cwd, default: []].append(session)
            }
            return AgentGroup(agent: agent, projects: cwds.map { Project(cwd: $0, name: ProjectPath.name(of: $0), sessions: byCwd[$0] ?? []) })
        }
    }
}
