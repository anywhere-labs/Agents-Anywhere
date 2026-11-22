// Control-plane shapes: `contracts/aa-v3/1.0/control.schema.json` (aa.v3.Control) and the FastAPI auth routes of
// `server-v3` (`/auth/login`, `/auth/refresh`, `/auth/router-token`).

import Foundation

// MARK: - Auth (HTTP)

public struct UserView: Codable, Sendable, Hashable {
    public var id: String
    public var email: String?
    public var displayName: String
    public var role: String
    public var createdAt: String?
    public var plan: String?

    enum CodingKeys: String, CodingKey {
        case id, email, role, plan
        case displayName = "display_name"
        case createdAt = "created_at"
    }

    public init(id: String, email: String?, displayName: String, role: String = "user", createdAt: String? = nil, plan: String? = nil) {
        self.id = id
        self.email = email
        self.displayName = displayName
        self.role = role
        self.createdAt = createdAt
        self.plan = plan
    }
}

public struct AuthTokenResponse: Codable, Sendable, Hashable {
    public var user: UserView
    public var accessToken: String
    public var refreshToken: String
    public var expiresIn: Int
    public var clientID: String

    enum CodingKeys: String, CodingKey {
        case user
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case expiresIn = "expires_in"
        case clientID = "client_id"
    }
}

public struct AuthConfigResponse: Codable, Sendable, Hashable {
    public var authMode: String
    public var needsBootstrap: Bool?
    public var registrationOpen: Bool?
    public var oauthEnabled: Bool?
    enum CodingKeys: String, CodingKey {
        case authMode = "auth_mode"
        case needsBootstrap = "needs_bootstrap"
        case registrationOpen = "registration_open"
        case oauthEnabled = "oauth_enabled"
    }
}

public struct RouterTokenEntry: Codable, Sendable, Hashable {
    public var routerID: String
    public var routerURL: String
    public var token: String
    public var tokenID: String
    public var expiresAt: String

    enum CodingKeys: String, CodingKey {
        case token
        case routerID = "router_id"
        case routerURL = "router_url"
        case tokenID = "token_id"
        case expiresAt = "expires_at"
    }
}

public struct ClientRouterTokenResponse: Codable, Sendable, Hashable {
    public var principal: String
    public var tokens: [RouterTokenEntry]
}

// MARK: - Devices (aa.v3.Control)

public struct NormalDeviceSummary: Codable, Sendable, Hashable {
    public var runtimes: [String]?
    public var activeSessions: Int?
    public var pendingApprovals: Int?
    enum CodingKeys: String, CodingKey {
        case runtimes
        case activeSessions = "active_sessions"
        case pendingApprovals = "pending_approvals"
    }
}

public struct DeviceRecord: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    /// `macos` | `linux` | `windows`.
    public var platform: String
    public var connectorVersion: String
    /// Server hint only (`normal` | `encrypted`): the local trust store is authoritative for encrypted devices.
    public var modeHint: String
    /// `online` | `offline`.
    public var presence: String
    public var createdAt: String
    public var lastSeenAt: String
    public var summary: NormalDeviceSummary?
    public var e2ePublicKeyHint: String?

    enum CodingKeys: String, CodingKey {
        case id, name, platform, presence, summary
        case connectorVersion = "connector_version"
        case modeHint = "mode_hint"
        case createdAt = "created_at"
        case lastSeenAt = "last_seen_at"
        case e2ePublicKeyHint = "e2e_public_key_hint"
    }

    public init(
        id: String, name: String, platform: String = "macos", connectorVersion: String = "", modeHint: String = "normal",
        presence: String = "online", createdAt: String = "", lastSeenAt: String = "", summary: NormalDeviceSummary? = nil
    ) {
        self.id = id
        self.name = name
        self.platform = platform
        self.connectorVersion = connectorVersion
        self.modeHint = modeHint
        self.presence = presence
        self.createdAt = createdAt
        self.lastSeenAt = lastSeenAt
        self.summary = summary
    }

    public var isOnline: Bool { presence == "online" }
    public var isEncryptedHint: Bool { modeHint == "encrypted" }
}

/// `aa.v3.Control/watch_devices` item: a snapshot, then whole-record upserts and removals.
public enum WatchDevicesEvent: Sendable, Hashable, Decodable {
    case snapshot([DeviceRecord])
    case upsert(DeviceRecord)
    case remove(String)
    case unknown

    private enum Keys: String, CodingKey { case type, devices, device, deviceID = "device_id" }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "snapshot": self = .snapshot(try container.decode([DeviceRecord].self, forKey: .devices))
        case "upsert": self = .upsert(try container.decode(DeviceRecord.self, forKey: .device))
        case "remove": self = .remove(try container.decode(String.self, forKey: .deviceID))
        default: self = .unknown
        }
    }

    /// Apply this event to a device list (order: name, then id).
    public func apply(to devices: [DeviceRecord]) -> [DeviceRecord] {
        var next = devices
        switch self {
        case .snapshot(let all): next = all
        case .upsert(let device):
            if let index = next.firstIndex(where: { $0.id == device.id }) { next[index] = device } else { next.append(device) }
        case .remove(let id): next.removeAll { $0.id == id }
        case .unknown: break
        }
        return next.sorted { ($0.name.localizedLowercase, $0.id) < ($1.name.localizedLowercase, $1.id) }
    }
}

public struct ListDevicesResponse: Codable, Sendable {
    public var devices: [DeviceRecord]
}

public struct OpenTunnelResponse: Codable, Sendable, Hashable {
    public var routerURL: String
    /// `mtun_…`, or `mtun_e2e.…` for an end-to-end tunnel.
    public var credential: String
    public var tunnelID: String
    public var expiresAt: String
    public var mode: String

    enum CodingKeys: String, CodingKey {
        case credential, mode
        case routerURL = "router_url"
        case tunnelID = "tunnel_id"
        case expiresAt = "expires_at"
    }

    public init(routerURL: String, credential: String, tunnelID: String, expiresAt: String, mode: String) {
        self.routerURL = routerURL
        self.credential = credential
        self.tunnelID = tunnelID
        self.expiresAt = expiresAt
        self.mode = mode
    }

    public var isEndToEnd: Bool { credential.hasPrefix("mtun_e2e.") }
}

public struct DeviceError: Codable, Sendable, Hashable {
    public var code: String
    public var message: String
    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

/// One device's answer in `aa.v3.Control/list_sessions` (or a client-side tunnel fan-out to an encrypted device).
public struct DeviceSessionResult: Codable, Sendable, Hashable {
    public var deviceID: String
    /// `ok` | `offline` | `timeout` | `error` | `encrypted`.
    public var status: String
    public var value: SessionList?
    public var error: DeviceError?

    enum CodingKeys: String, CodingKey {
        case status, value, error
        case deviceID = "device_id"
    }

    public init(deviceID: String, status: String, value: SessionList? = nil, error: DeviceError? = nil) {
        self.deviceID = deviceID
        self.status = status
        self.value = value
        self.error = error
    }
}

public struct ListSessionsOnceResponse: Codable, Sendable {
    public var results: [DeviceSessionResult]
}

// MARK: - aa.v3.Device

public struct RuntimeInfo: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public struct DeviceStatus: Codable, Sendable, Hashable {
    public var deviceID: String
    public var deviceName: String
    public var platform: String
    public var hostname: String
    public var cwd: String
    public var arch: String
    public var nodeVersion: String?
    public var connectorVersion: String
    public var uptimeSeconds: Int
    public var mode: String
    public var allowMCP: Bool
    public var runtimes: [RuntimeInfo]

    enum CodingKeys: String, CodingKey {
        case platform, hostname, cwd, arch, mode, runtimes
        case deviceID = "device_id"
        case deviceName = "device_name"
        case nodeVersion = "node_version"
        case connectorVersion = "connector_version"
        case uptimeSeconds = "uptime_seconds"
        case allowMCP = "allow_mcp"
    }
}

public struct DirEntry: Codable, Sendable, Hashable, Identifiable {
    public var name: String
    public var path: String
    public var isDir: Bool
    public var isSymlink: Bool
    public var size: Double
    public var mtime: String?
    public var id: String { path }
    enum CodingKeys: String, CodingKey {
        case name, path, size, mtime
        case isDir = "is_dir"
        case isSymlink = "is_symlink"
    }
}

public struct ListDirsResult: Codable, Sendable, Hashable {
    public var path: String
    public var parent: String?
    public var entries: [DirEntry]
    public var truncated: Bool
}

public struct ReadFileResult: Codable, Sendable, Hashable {
    public var path: String
    public var size: Double
    public var offset: Double
    public var bytesRead: Double
    public var eof: Bool
    /// `utf8` | `base64`.
    public var encoding: String
    public var content: String
    public var mtime: String

    enum CodingKeys: String, CodingKey {
        case path, size, offset, eof, encoding, content, mtime
        case bytesRead = "bytes_read"
    }

    /// The bytes read, whatever the encoding.
    public var data: Data? {
        encoding == "base64" ? Data(base64Encoded: content) : content.data(using: .utf8)
    }
}

public struct SavedAttachment: Codable, Sendable, Hashable {
    public var id: String
    public var path: String
    public var name: String
    public var mime: String
    public var size: Int

    public var part: AttachmentPart { AttachmentPart(path: path, name: name, mime: mime, size: size) }
}

public struct PairedClientEntry: Codable, Sendable, Hashable, Identifiable {
    public var clientPub: String
    public var label: String
    public var platform: String
    public var pairedAt: String
    public var lastSeenAt: String?
    public var id: String { clientPub }
    enum CodingKeys: String, CodingKey {
        case label, platform
        case clientPub = "client_pub"
        case pairedAt = "paired_at"
        case lastSeenAt = "last_seen_at"
    }
}

// MARK: - aa.v3.Terminals

public struct TerminalInfo: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var cwd: String
    public var shell: String
    public var cols: Int
    public var rows: Int
    public var createdAt: String
    public var running: Bool
    public var exitCode: Int?
    public var exitSignal: String?
    public var exitedAt: String?
    public var pid: Int?
    public var mode: String?

    enum CodingKeys: String, CodingKey {
        case id, cwd, shell, cols, rows, running, pid, mode
        case createdAt = "created_at"
        case exitCode = "exit_code"
        case exitSignal = "exit_signal"
        case exitedAt = "exited_at"
    }
}

public struct TerminalList: Codable, Sendable {
    public var terminals: [TerminalInfo]
}

public struct OkResponse: Codable, Sendable, Hashable {
    public var ok: Bool
}
