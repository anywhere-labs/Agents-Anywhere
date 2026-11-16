import Foundation
import os
import Synchronization

/// Opens a session's display envelopes (protocol 1.2 `displayDevice` / `displayUser`) and
/// writes the result into the session's `title` and `cwd`, so every list, page and file
/// browser reads the same values as before encryption. Same rules as Web/Desktop
/// (`features/e2ee/display.ts`).
///
/// - Normal mode (no sealed envelope): title = `displayUser.title ?? displayDevice.title`,
///   cwd = `displayDevice.cwd`, each falling back to the Server's plaintext field.
/// - Encrypted mode (any sealed envelope): only the sealed envelopes count; plain envelopes
///   next to them and the Server's `title` / `cwd` are ignored. Each is opened with the
///   device's directory key (`connectorId`), AD = `(connectorId, sessionId, slot, keyId)`.
///   When any of them does not open (no key for its `keyId`, wrong key, tampered payload),
///   the title is the locked placeholder and `cwd` is nil.
/// - Sessions without envelopes are returned unchanged; unknown fields are ignored.
///
/// Opened payloads are cached in memory by `(sessionId, slot, keyId, payload)`. Failures are
/// not cached, so a new directory key (`e2ee.directory_key`, pairing again) only needs the
/// owners to resolve their sessions again.
nonisolated final class V2SessionDisplayResolver: Sendable {
    typealias DirectoryKey = (keyId: String, key: Data)
    typealias KeyLookup = @Sendable (V2ConnectorID) -> DirectoryKey?

    nonisolated enum Slot: Hashable {
        case absent
        case locked
        case open([String: JSONValue])

        func text(_ field: String) -> String? {
            guard case let .open(fields) = self, case let .string(value)? = fields[field] else { return nil }
            return value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : value
        }
    }

    private struct CacheKey: Hashable {
        let sessionId: V2SessionID
        let slot: E2EEDisplaySlot
        let keyId: String
        let payload: String
    }

    static var lockedTitle: String { String(localized: "e2ee.display.locked") }
    private static let maximumCacheEntries = 4096
    private static let log = Logger(subsystem: "agents.anywhere", category: "e2ee-display")

    private let keys: KeyLookup
    private let cache = Mutex<[CacheKey: [String: JSONValue]]>([:])

    init(keys: @escaping KeyLookup) {
        self.keys = keys
    }

    /// Reads the current-epoch directory key from the trust store. Only one epoch is kept on
    /// this phone, so an envelope sealed with an older `keyId` stays locked.
    convenience init(trust: ClientTrustStore) {
        self.init { deviceId in
            guard let record = try? trust.device(deviceId), let key = record.directoryKeyBytes else { return nil }
            return (record.directoryKey.keyId, key)
        }
    }

    func clearCache() {
        cache.withLock { $0.removeAll() }
    }

    func resolve(_ session: V2SessionMeta) -> V2SessionMeta {
        let device = session.displayDevice, user = session.displayUser
        guard device != nil || user != nil else { return session }
        var result = session
        guard device?.mode == .sealed || user?.mode == .sealed else {
            let deviceFields = Self.plain(device), userFields = Self.plain(user)
            result.title = userFields.text("title") ?? deviceFields.text("title") ?? session.title
            result.cwd = deviceFields.text("cwd") ?? session.cwd
            result.displayLocked = nil
            return result
        }
        let deviceFields = device?.mode == .sealed ? open(device, session: session, slot: .device) : .absent
        let userFields = user?.mode == .sealed ? open(user, session: session, slot: .user) : .absent
        if deviceFields == .locked || userFields == .locked {
            result.title = Self.lockedTitle
            result.cwd = nil
            result.displayLocked = true
        } else {
            result.title = userFields.text("title") ?? deviceFields.text("title")
            result.cwd = deviceFields.text("cwd")
            result.displayLocked = nil
        }
        return result
    }

    /// A plain envelope's object (a JSON string holding one is accepted too).
    private static func plain(_ envelope: V2DisplayEnvelope?) -> Slot {
        guard let envelope, envelope.mode == .plain else { return .absent }
        switch envelope.payload {
        case let .object(fields):
            return .open(fields)
        case let .string(text):
            guard let data = text.data(using: .utf8), case let .object(fields)? = try? JSONDecoder().decode(JSONValue.self, from: data)
            else { return .absent }
            return .open(fields)
        default:
            return .absent
        }
    }

    /// A sealed envelope: `.open` or `.locked`.
    private func open(_ envelope: V2DisplayEnvelope?, session: V2SessionMeta, slot: E2EEDisplaySlot) -> Slot {
        guard let envelope, let keyId = envelope.keyId, !keyId.isEmpty, case let .string(payload) = envelope.payload,
              !payload.isEmpty else { return .locked }
        let cacheKey = CacheKey(sessionId: session.id, slot: slot, keyId: keyId, payload: payload)
        if let fields = cache.withLock({ $0[cacheKey] }) { return .open(fields) }
        guard let key = keys(session.connectorId), key.keyId == keyId else { return .locked }
        do {
            let ad = try E2EEFormats.displayEnvelopeAD(deviceId: session.connectorId, sessionId: session.id, slot: slot, keyId: keyId)
            let plaintext = try E2EEFormats.openDisplayEnvelope(key: key.key, ad: ad, payload: payload)
            guard case let .object(fields) = try JSONDecoder().decode(JSONValue.self, from: plaintext) else { return .locked }
            cache.withLock { cache in
                if cache.count >= Self.maximumCacheEntries { cache.removeAll() }
                cache[cacheKey] = fields
            }
            return .open(fields)
        } catch {
            Self.log.debug("display envelope \(slot.rawValue, privacy: .public) of \(session.id, privacy: .public) did not open")
            return .locked
        }
    }
}

/// Encrypted mode: the Server cannot read `cwd`, so a session the device found by itself
/// (import, scan) arrives without a project. The client matches the decrypted `cwd`
/// (Web/Desktop: `features/e2ee/project-assignment.ts`).
nonisolated enum V2SessionProjectMatch {
    /// Trimmed, without trailing separators. Only `X:\` paths are Windows paths: they compare
    /// case-insensitively and treat `/` as `\`. Everything else is case-sensitive.
    static func normalize(_ path: String) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        if isWindows(trimmed) {
            var value = trimmed.replacingOccurrences(of: "/", with: "\\")
            while value.hasSuffix("\\") { value.removeLast() }
            return value.lowercased()
        }
        var value = trimmed
        while value.hasSuffix("/") { value.removeLast() }
        return value.isEmpty && trimmed.hasPrefix("/") ? "/" : value
    }

    /// The project of the same device whose workspace is `cwd`, or else the one with the
    /// longest workspace path that contains `cwd` (whole path segments only).
    static func project(forCwd cwd: String, connectorID: V2ConnectorID, projects: [V2Project]) -> V2Project? {
        let target = normalize(cwd)
        guard !target.isEmpty else { return nil }
        let windows = isWindows(cwd.trimmingCharacters(in: .whitespacesAndNewlines))
        let separator = windows ? "\\" : "/"
        var best: (project: V2Project, length: Int)?
        for project in projects where project.connectorId == connectorID {
            guard isWindows(project.workspacePath.trimmingCharacters(in: .whitespacesAndNewlines)) == windows else { continue }
            let path = normalize(project.workspacePath)
            guard !path.isEmpty else { continue }
            if path == target { return project }
            let prefix = path.hasSuffix(separator) ? path : path + separator
            guard target.hasPrefix(prefix), path.count > (best?.length ?? -1) else { continue }
            best = (project, path.count)
        }
        return best?.project
    }

    private static func isWindows(_ path: String) -> Bool {
        path.range(of: "^[A-Za-z]:[\\\\/]", options: .regularExpression) != nil
    }
}
