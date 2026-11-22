// Secrets: refresh/access tokens, the client's X25519 private key and the encrypted-device trust records.
// The app uses the Keychain (`KeychainStore`); tests use `MemorySecretStore`.

import Foundation
import Security

public protocol SecretStore: Sendable {
    func data(for key: String) throws -> Data?
    func set(_ data: Data, for key: String) throws
    func remove(_ key: String) throws
}

extension SecretStore {
    public func string(for key: String) throws -> String? {
        try data(for: key).flatMap { String(data: $0, encoding: .utf8) }
    }

    public func set(_ string: String, for key: String) throws {
        try set(Data(string.utf8), for: key)
    }

    public func value<T: Decodable>(_ type: T.Type, for key: String) throws -> T? {
        guard let data = try data(for: key) else { return nil }
        return try JSONDecoder().decode(T.self, from: data)
    }

    public func setValue<T: Encodable>(_ value: T, for key: String) throws {
        try set(JSONEncoder().encode(value), for: key)
    }
}

public struct KeychainError: Error, CustomStringConvertible {
    public let status: OSStatus
    public var description: String { "Keychain error \(status)" }
}

/// Generic-password Keychain items under one service, readable after first unlock on this device only
/// (never synced through iCloud Keychain: the X25519 key is per installation, as the e2ee design requires).
public struct KeychainStore: SecretStore {
    public let service: String

    public init(service: String = "dev.agentsanywhere.v3") {
        self.service = service
    }

    private func query(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    public func data(for key: String) throws -> Data? {
        var query = query(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        return result as? Data
    }

    public func set(_ data: Data, for key: String) throws {
        let base = query(key)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(base as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var add = base
            add.merge(attributes) { _, new in new }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func remove(_ key: String) throws {
        let status = SecItemDelete(query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }
}

/// In-memory store for tests and previews.
public final class MemorySecretStore: SecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]

    public init() {}

    public func data(for key: String) throws -> Data? {
        lock.withLock { items[key] }
    }

    public func set(_ data: Data, for key: String) throws {
        lock.withLock { items[key] = data }
    }

    public func remove(_ key: String) throws {
        _ = lock.withLock { items.removeValue(forKey: key) }
    }
}

/// This installation's X25519 key for `Noise_IK` / `Noise_IKpsk2`. Generated once; only the public key ever
/// leaves the device (inside the handshake).
public struct ClientIdentityStore: Sendable {
    static let key = "client_x25519_private_key"
    private let store: any SecretStore

    public init(store: any SecretStore) {
        self.store = store
    }

    public func privateKey() throws -> String {
        if let existing = try store.string(for: Self.key) { return existing }
        let pair = E2EKeyPair.generate()
        try store.set(pair.privateKey, for: Self.key)
        return pair.privateKey
    }

    public func publicKey() throws -> String {
        try E2EKeyPair.publicKey(of: privateKey())
    }
}
