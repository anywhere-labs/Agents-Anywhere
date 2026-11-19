import CryptoKit
import Foundation
import MeshCall
import Security

@MainActor
final class ContentPairing {
    private let server: URL
    private let deviceID: String
    private let invitation: String?
    private let accessToken: () async throws -> String
    private let storage: PrivateKeychain<ContentPairingRecord>
    private var active: PairedContent?
    private var connecting: Task<PairedContent, Error>?

    init(server: URL, accountID: String, deviceID: String, invitation: String?, accessToken: @escaping () async throws -> String) {
        self.server = server
        self.deviceID = deviceID
        self.invitation = invitation
        self.accessToken = accessToken
        let scope = [Self.serverScope(server), accountID, deviceID].joined(separator: "\u{0}")
        storage = PrivateKeychain(service: "AgentsAnywhere.MeshCall.Content", account: Data(SHA256.hash(data: Data(scope.utf8))).base64EncodedString())
    }

    func connect() async throws -> PairedContent {
        if let active { return active }
        if let connecting { return try await connecting.value }
        let task = Task { try await prepare() }
        connecting = task
        defer { connecting = nil }
        let paired = try await task.value
        active = paired
        return paired
    }

    private func prepare() async throws -> PairedContent {
        let saved = try await storage.read()
        if let saved, let clientID = saved.clientID, invitation == nil {
            return PairedContent(
                transport: transport(pinnedKey: saved.connectorKey),
                authorization: ContentAuthorization(clientID: clientID, credential: saved.secret)
            )
        }

        let invite = try PairingInvitation.parse(invitation)
        guard invite.deviceId == deviceID, Self.serverScope(invite.serverUrl) == Self.serverScope(server) else {
            throw ContentPairingError.targetMismatch
        }
        if let saved, saved.connectorKey != invite.deviceIdentityPub {
            throw DeviceContentError.identityMismatch
        }
        let record: ContentPairingRecord
        if let saved {
            record = saved
        } else {
            let key = E2EKeyPair.generate()
            // The Connector keeps only a digest of the 256-bit application credential.
            record = ContentPairingRecord(
                connectorKey: invite.deviceIdentityPub, identity: key.publicKey,
                secret: E2EKeyPair.generate().privateKey, clientID: nil
            )
            try await storage.write(record)
        }
        let transport = transport(pinnedKey: record.connectorKey)
        do {
            let result = try await transport.pair(ContentPairRequest(
                clientIdentityPub: record.identity, clientSecret: record.secret, label: "iOS",
                pairingId: invite.pairingId, pairingSecret: invite.psk, platform: "ios"
            ))
            var accepted = record
            accepted.clientID = result.clientId
            try await storage.write(accepted)
            return PairedContent(
                transport: transport,
                authorization: ContentAuthorization(clientID: result.clientId, credential: record.secret)
            )
        } catch {
            await transport.invalidate()
            throw error
        }
    }

    func close() async {
        connecting?.cancel()
        let previous = active
        active = nil
        await previous?.transport.invalidate()
    }

    func forget() async throws {
        await close()
        try await storage.remove()
    }

    private func transport(pinnedKey: String) -> DeviceContentTransport {
        DeviceContentTransport(server: server, instanceID: deviceID, pinnedKey: pinnedKey, accessToken: accessToken)
    }

    private static func serverScope(_ value: URL) -> String {
        value.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
}

struct PairedContent {
    let transport: DeviceContentTransport
    let authorization: ContentAuthorization
}

private struct PairingInvitation: Decodable {
    let v: Int
    let deviceId: String
    let deviceIdentityPub: String
    let pairingId: String
    let psk: String
    let serverUrl: URL
    let e2eeMode: String

    static func parse(_ uri: String?) throws -> Self {
        let prefix = "aa-pair://"
        guard let uri, uri.hasPrefix(prefix), let data = base64URLData(String(uri.dropFirst(prefix.count))) else {
            throw ContentPairingError.invitationRequired
        }
        guard let invite = try? JSONDecoder().decode(Self.self, from: data),
              invite.v == 1, invite.e2eeMode == "required", !invite.pairingId.isEmpty,
              base64URLData(invite.deviceIdentityPub)?.count == 32, base64URLData(invite.psk)?.count == 32 else {
            throw ContentPairingError.invalidInvitation
        }
        return invite
    }

    private static func base64URLData(_ input: String) -> Data? {
        let encoded = input.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        return Data(base64Encoded: encoded + String(repeating: "=", count: (4 - encoded.count % 4) % 4))
    }
}

private nonisolated struct ContentPairingRecord: Codable, Sendable {
    let connectorKey: String
    let identity: String
    let secret: String
    var clientID: String?
}

actor PrivateKeychain<Record: Codable & Sendable> {
    let service: String
    let account: String

    init(service: String, account: String) {
        self.service = service
        self.account = account
    }

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
    }

    func read() throws -> Record? {
        var readQuery = query
        readQuery[kSecReturnData as String] = true
        readQuery[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(readQuery as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let bytes = item as? Data else {
            throw ContentPairingError.storage(status)
        }
        guard let record = try? JSONDecoder().decode(Record.self, from: bytes) else {
            throw ContentPairingError.invalidRecord
        }
        return record
    }

    func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw ContentPairingError.storage(status) }
    }

    func write(_ record: Record) throws {
        let attributes = [kSecValueData as String: try JSONEncoder().encode(record)]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query.merging(attributes) { _, value in value }
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(insert as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw ContentPairingError.storage(status) }
    }
}

enum ContentPairingError: Error {
    case invitationRequired
    case invalidInvitation
    case targetMismatch
    case invalidRecord
    case storage(OSStatus)
}
