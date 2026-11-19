import CryptoKit
import Foundation
import MeshCall
import Security
import Synchronization

/// 保存 E2EE 秘密的地方。默认是 Keychain；测试用内存实现。
nonisolated protocol E2EESecureStorage: Sendable {
    func read(account: String) throws -> Data?
    func write(_ data: Data, account: String) throws
    func delete(account: String) throws
}

/// Keychain：`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`，明确不同步到 iCloud 钥匙串，不随备份迁移。
nonisolated struct E2EEKeychainStorage: E2EESecureStorage {
    let service: String

    init(service: String = "AgentsAnywhere.E2EE") {
        self.service = service
    }

    func read(account: String) throws -> Data? {
        var query = baseQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw E2EEStorageError.keychain(status) }
        return item as? Data
    }

    func write(_ data: Data, account: String) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(baseQuery(account) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let insert = baseQuery(account).merging(attributes) { $1 }
            let added = SecItemAdd(insert as CFDictionary, nil)
            guard added == errSecSuccess else { throw E2EEStorageError.keychain(added) }
            return
        }
        guard status == errSecSuccess else { throw E2EEStorageError.keychain(status) }
    }

    func delete(account: String) throws {
        let status = SecItemDelete(baseQuery(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw E2EEStorageError.keychain(status) }
    }

    private func baseQuery(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
        ]
    }
}

nonisolated final class E2EEMemoryStorage: E2EESecureStorage {
    private let items = Mutex<[String: Data]>([:])

    init() {}

    func read(account: String) throws -> Data? { items.withLock { $0[account] } }
    func write(_ data: Data, account: String) throws { items.withLock { $0[account] = data } }
    func delete(account: String) throws { items.withLock { _ = $0.removeValue(forKey: account) } }
    var accounts: [String] { items.withLock { Array($0.keys) } }
}

nonisolated enum E2EEStorageError: LocalizedError {
    case keychain(OSStatus)
    case corrupted

    var errorDescription: String? {
        switch self {
        case let .keychain(status):
            String(localized: "e2ee.error.keychain \(String(status))")
        case .corrupted:
            String(localized: "e2ee.error.keychainCorrupted")
        }
    }
}

/// 一台已配对设备在本机的记录。
nonisolated struct E2EEDeviceTrust: Codable, Hashable, Sendable {
    let deviceId: String
    /// 钉住的设备身份公钥（base64url）。只有重新扫码配对能改它。
    let devicePub: String
    let grantedAt: String
    var directoryKey: E2EEDirectoryKeyGrant

    var devicePubBytes: Data? { try? E2EEFormats.fromBase64url(devicePub) }
    var fingerprint: String { devicePubBytes.map(E2EEFormats.fingerprint) ?? "" }
    var directoryKeyBytes: Data? { try? E2EEFormats.fromBase64url(directoryKey.key) }
}

/// Client Trust：客户端身份密钥、每台设备钉住的公钥与列表密钥、「该设备要求加密」的本机策略。
///
/// 一个账号（Server + 用户）一份，互不可见。所有内容都在 Keychain 里；内存里只缓存读过的值。
/// 本机策略只能加不能减：Server 之后说 off、设备被忘记，都不会让它放松（降级保护 E-3）。
nonisolated final class ClientTrustStore: Sendable {
    private struct State {
        var identity: X25519KeyPair?
        var devices: [String: E2EEDeviceTrust]?
        var required: Set<String>?
    }

    private let storage: any E2EESecureStorage
    private let scope: String
    private let state = Mutex(State())
    private let observers = Mutex<[UUID: @Sendable () -> Void]>([:])

    /// - Parameter scope: 账号范围的稳定字符串（例如 Server 地址与用户 ID 的摘要）。
    init(storage: any E2EESecureStorage, scope: String) {
        self.storage = storage
        self.scope = scope
    }

    private var identityAccount: String { "\(scope).identity" }
    private var devicesAccount: String { "\(scope).devices" }
    private var requiredAccount: String { "\(scope).required" }

    /// 客户端身份密钥；第一次用到时生成并写入 Keychain。
    func identity() throws -> X25519KeyPair {
        try state.withLock { state in
            if let identity = state.identity { return identity }
            let identity: X25519KeyPair
            if let secret = try storage.read(account: identityAccount) {
                guard let pair = try? X25519KeyPair(secret: secret) else { throw E2EEStorageError.corrupted }
                identity = pair
            } else {
                identity = NoiseCrypto.generateKeyPair()
                try storage.write(identity.privateKey.rawRepresentation, account: identityAccount)
            }
            state.identity = identity
            return identity
        }
    }

    /// 设备记录变了（配对、列表密钥轮换、忘记设备）之后调用，在调用方的线程上，不持有锁。
    /// 用来让解不开的展示信封用新的列表密钥重试。
    @discardableResult
    func observeDevices(_ handler: @escaping @Sendable () -> Void) -> UUID {
        let id = UUID()
        observers.withLock { $0[id] = handler }
        return id
    }

    func removeObserver(_ id: UUID) {
        observers.withLock { _ = $0.removeValue(forKey: id) }
    }

    private func notifyDevicesChanged() {
        for handler in observers.withLock({ Array($0.values) }) { handler() }
    }

    func clientId() throws -> String {
        E2EEFormats.clientId(for: try identity().publicKey)
    }

    func device(_ deviceId: String) throws -> E2EEDeviceTrust? {
        try state.withLock { try loadDevices(&$0)[deviceId] }
    }

    func devices() throws -> [E2EEDeviceTrust] {
        try state.withLock { Array(try loadDevices(&$0).values) }
    }

    /// `pair.committed` 之后记下授权：钉住设备公钥、保存列表密钥。
    func meshCredential(deviceId: String, pin: String, create: Bool = false) throws -> String? {
        try state.withLock { _ in
            let account = "\(scope).mesh.\(deviceId)"
            if let bytes = try storage.read(account: account),
               let record = try? JSONDecoder().decode(MeshCredential.self, from: bytes), record.pin == pin {
                return record.secret
            }
            guard create else { return nil }
            let record = MeshCredential(pin: pin, secret: E2EKeyPair.generate().privateKey)
            try storage.write(JSONEncoder().encode(record), account: account)
            return record.secret
        }
    }

    private struct MeshCredential: Codable {
        let pin: String
        let secret: String
    }

    func savePairing(_ result: E2EEPairingResult) throws {
        try state.withLock { state in
            var devices = try loadDevices(&state)
            devices[result.deviceId] = E2EEDeviceTrust(
                deviceId: result.deviceId,
                devicePub: E2EEFormats.base64url(result.devicePub),
                grantedAt: result.grantedAt,
                directoryKey: result.directoryKey
            )
            try saveDevices(devices, into: &state)
        }
        notifyDevicesChanged()
    }

    /// 设备轮换列表密钥（`e2ee.directory_key` 或 `GET /e2ee/v1/directory-key`）。旧纪元不会覆盖新纪元。
    @discardableResult
    func updateDirectoryKey(_ grant: E2EEDirectoryKeyGrant) throws -> Bool {
        let updated = try state.withLock { state -> Bool in
            var devices = try loadDevices(&state)
            guard var record = devices[grant.deviceId], grant.epoch >= record.directoryKey.epoch,
                  grant != record.directoryKey,
                  (try? E2EEFormats.fromBase64url(grant.key).count) == 32
            else { return false }
            record.directoryKey = grant
            devices[grant.deviceId] = record
            try saveDevices(devices, into: &state)
            return true
        }
        if updated { notifyDevicesChanged() }
        return updated
    }

    /// 忘记一台设备的授权（之后要重新扫码）。「要求加密」的记录保留。
    func forget(_ deviceId: String) throws {
        try storage.delete(account: "\(scope).mesh.\(deviceId)")
        let removed = try state.withLock { state -> Bool in
            var devices = try loadDevices(&state)
            guard devices.removeValue(forKey: deviceId) != nil else { return false }
            try saveDevices(devices, into: &state)
            return true
        }
        if removed { notifyDevicesChanged() }
    }

    func requiresEncryption(_ deviceId: String) throws -> Bool {
        try state.withLock { try loadRequired(&$0).contains(deviceId) }
    }

    /// 记下「该设备要求加密」。没有撤销的方法。
    func markRequired(_ deviceId: String) throws {
        try state.withLock { state in
            var required = try loadRequired(&state)
            guard required.insert(deviceId).inserted else { return }
            try storage.write(try JSONEncoder().encode(required.sorted()), account: requiredAccount)
            state.required = required
        }
    }

    private func loadDevices(_ state: inout State) throws -> [String: E2EEDeviceTrust] {
        if let devices = state.devices { return devices }
        var devices: [String: E2EEDeviceTrust] = [:]
        if let data = try storage.read(account: devicesAccount) {
            guard let list = try? JSONDecoder().decode([E2EEDeviceTrust].self, from: data) else { throw E2EEStorageError.corrupted }
            devices = Dictionary(list.map { ($0.deviceId, $0) }) { _, last in last }
        }
        state.devices = devices
        return devices
    }

    private func saveDevices(_ devices: [String: E2EEDeviceTrust], into state: inout State) throws {
        let list = devices.values.sorted { $0.deviceId < $1.deviceId }
        try storage.write(try JSONEncoder().encode(list), account: devicesAccount)
        state.devices = devices
    }

    private func loadRequired(_ state: inout State) throws -> Set<String> {
        if let required = state.required { return required }
        var required: Set<String> = []
        if let data = try storage.read(account: requiredAccount) {
            guard let list = try? JSONDecoder().decode([String].self, from: data) else { throw E2EEStorageError.corrupted }
            required = Set(list)
        }
        state.required = required
        return required
    }
}
