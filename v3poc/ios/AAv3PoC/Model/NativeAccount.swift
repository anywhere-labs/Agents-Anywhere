import CommonCrypto
import CryptoKit
import Foundation
import MeshCall

private nonisolated struct NativeLogin: Codable, Sendable {
    let userId: String
    let displayName: String
    let email: String?
    let accessToken: String
    let expiresAt: String
    let refreshToken: String
}

private nonisolated struct SavedLogin: Codable, Sendable {
    let server: URL
    var credentials: NativeLogin
    var device: String?
}

enum NativeAccountError: Error {
    case address
    case http(Int)
    case invalidResponse
}

nonisolated final class AccountRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class NativeAccount {
    private let storage = PrivateKeychain<SavedLogin>(service: "AgentsAnywhere.MeshCall.Account", account: "current")
    private let session = URLSession(configuration: .ephemeral, delegate: AccountRedirects(), delegateQueue: nil)
    private var login: SavedLogin?
    private var refreshing: Task<String, Error>?

    func restore() async throws -> Bool {
        login = try await storage.read()
        return login != nil
    }

    func signIn(address: String, email: String, password: String) async throws {
        let server = try Self.server(address)
        let normalized = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let saltData = try await call(server, "auth/password-salt", body: ["email": .string(normalized)])
        guard let salt = try JSON.decode(saltData)["salt"]?.string else { throw NativeAccountError.invalidResponse }
        let verifier = try await Task.detached(priority: .userInitiated) { try passwordVerifier(password, salt: salt) }.value
        let data: Data
        do {
            data = try await call(server, "auth/login", body: ["email": .string(normalized), "passwordVerifier": .string(verifier)])
        } catch NativeAccountError.http(401) {
            // Accounts created with the legacy password API still use the server-side password hash.
            data = try await call(server, "auth/login", body: ["email": .string(normalized), "password": .string(password)])
        }
        let token = try JSONDecoder().decode(NativeLogin.self, from: data)
        try await save(SavedLogin(server: server, credentials: token))
    }

    func devices() async throws -> (known: [Workspace.Device], recent: String?) {
        let previous = try saved().device
        let data = try await directory("devices")
        let devices = (data["connectors"]?.array ?? []).compactMap { row -> Workspace.Device? in
            guard let id = row["id"]?.string else { return nil }
            return .init(id: id, name: row["name"]?.string ?? "", presence: row["status"]?.string ?? "",
                         platform: row["deviceOs"]?.string ?? "")
        }
        return (devices, previous)
    }

    func open(device: Workspace.Device, invitation: String?) async throws -> OnlineWorkspace {
        let current = try saved()
        let account = current.credentials
        let pairing = ContentPairing(server: current.server, accountID: account.userId, deviceID: device.id,
                                     invitation: invitation, accessToken: accessToken)
        do {
            let paired = try await pairing.connect()
            let result = try await paired.transport.request(
                ContentRequest(method: "GET", path: "/e2ee/v1/directory-key"), authorization: paired.authorization
            )
            guard result.status == 200, let body = result.body else { throw NativeAccountError.http(result.status) }
            let grant = try JSON.decode(JSONEncoder().encode(body))
            let projectData = try await directory("projects")
            let projects = (projectData["projects"]?.array ?? []).compactMap { row -> Workspace.Project? in
                guard row["connectorId"]?.string == device.id, let cwd = row["workspacePath"]?.string else { return nil }
                return .init(device_id: device.id, cwd: cwd, name: row["name"]?.string ?? "", remoteId: row["id"]?.string)
            }
            let runtimeData = try await directory("runtimes", deviceID: device.id)
            let runtimes = (runtimeData["runtimes"]?.array ?? []).compactMap { row -> RuntimeChoice? in
                guard row["active"]?.bool == true, row["available"]?.bool == true,
                      let id = row["runtimeId"]?.string, let type = row["runtimeType"]?.string else { return nil }
                return .init(id: id, type: type, name: row["name"]?.string ?? type)
            }
            let sessions = try await loadSessions(device: device, grant: grant)
            var updated = try saved()
            updated.device = device.id
            try await save(updated)
            let workspace = Workspace(
                account: .init(name: account.displayName.isEmpty ? account.email ?? "" : account.displayName, email: account.email ?? ""),
                devices: [device], projects: projects, sessions: sessions
            )
            return OnlineWorkspace(workspace: workspace, client: MeshSessionsClient(device: device, runtimes: runtimes, upload: stageAttachment, connect: pairing.connect), close: pairing.close)
        } catch {
            await pairing.close()
            throw error
        }
    }

    private func stageAttachment(sessionID: String, file: LocalChatFile) async throws -> StagedAttachment {
        let server = try saved().server
        let sealed = try await Task.detached(priority: .userInitiated) { try SealedChatFile(file) }.value
        try Task.checkCancellation()
        let boundary = UUID().uuidString
        var request = URLRequest(url: server.appending(path: "api/v2/sessions").appending(component: sessionID).appending(component: "attachments"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(try await accessToken())", forHTTPHeaderField: "Authorization")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("segments-v1", forHTTPHeaderField: "x-aa-sealed")
        let (data, response) = try await session.upload(for: request, from: sealed.multipart(boundary: boundary))
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              let attachment = try JSON.decode(data)["attachments"]?.array?.first
        else { throw NativeAccountError.invalidResponse }
        return try sealed.staged(reference: attachment)
    }

    func forgetPairing(device: Workspace.Device) async throws {
        let current = try saved()
        let pairing = ContentPairing(server: current.server, accountID: current.credentials.userId, deviceID: device.id,
                                     invitation: nil, accessToken: accessToken)
        try await pairing.forget()
        var updated = try saved()
        if updated.device == device.id {
            updated.device = nil
            try await save(updated)
        }
    }

    func signOut() async throws {
        do {
            let current = try saved()
            _ = try await call(current.server, "auth/logout", body: [:], token: accessToken())
        } catch {
            login = nil
            try await storage.remove()
            throw error
        }
        login = nil
        try await storage.remove()
    }

    private func loadSessions(device: Workspace.Device, grant: JSON) async throws -> [Workspace.Session] {
        var sessions: [Workspace.Session] = []
        var cursor: String?
        repeat {
            let page = try await directory("sessions", cursor: cursor)
            for row in page["sessions"]?.array ?? [] {
                guard row["connectorId"]?.string == device.id, let id = row["id"]?.string else { continue }
                let own = openDisplay(row["displayDevice"], grant: grant, device: device.id, session: id, slot: "device")
                let renamed = openDisplay(row["displayUser"], grant: grant, device: device.id, session: id, slot: "user")
                sessions.append(.init(
                    id: id, title: renamed?["title"]?.string ?? own?["title"]?.string ?? String(localized: "connection.encrypted_session"),
                    agent: row["runtimeType"]?.string ?? row["runtime"]?.string ?? "", device_id: device.id,
                    cwd: own?["cwd"]?.string ?? "", state: row["status"]?.string ?? "",
                    unread: row["unread"]?.bool ?? false, pinned: row["pinned"]?.bool ?? false,
                    updated_at: row["lastActivityAt"]?.string ?? ""
                ))
            }
            let next = page["nextCursor"]?.string
            if let cursor, next == cursor { throw NativeAccountError.invalidResponse }
            cursor = page["hasMore"]?.bool == true ? next : nil
        } while cursor != nil
        return sessions
    }

    private func accessToken() async throws -> String {
        if let refreshing { return try await refreshing.value }
        let current = try saved()
        let expiry = try Date(current.credentials.expiresAt, strategy: .iso8601)
        if expiry.timeIntervalSinceNow > 30 { return current.credentials.accessToken }
        let pending = Task {
            let data = try await call(current.server, "auth/refresh", body: ["refreshToken": .string(current.credentials.refreshToken)])
            let credentials = try JSONDecoder().decode(NativeLogin.self, from: data)
            var updated = try saved()
            guard updated.credentials.userId == credentials.userId else { throw NativeAccountError.http(401) }
            updated.credentials = credentials
            try await save(updated)
            return credentials.accessToken
        }
        refreshing = pending
        defer { refreshing = nil }
        return try await pending.value
    }

    private func saved() throws -> SavedLogin {
        guard let login else { throw NativeAccountError.http(401) }
        return login
    }

    private func save(_ value: SavedLogin) async throws {
        try await storage.write(value)
        login = value
    }

    private func directory(_ resource: String, deviceID: String? = nil, cursor: String? = nil) async throws -> JSON {
        try await withMobileControl(server: saved().server, accessToken: accessToken) { control, instance in
            let response = try await control.readDirectory(instance: instance, cursor: cursor, deviceId: deviceID, resource: resource)
            return try JSON.decode(JSONEncoder().encode(response.body))
        }
    }

    private func call(_ server: URL, _ route: String, body: [String: JSON]? = nil,
                      token: String? = nil, query: [URLQueryItem] = []) async throws -> Data {
        var url = server.appending(path: "api/v2/" + route)
        url.append(queryItems: query)
        var request = URLRequest(url: url, timeoutInterval: 20)
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw NativeAccountError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw NativeAccountError.http(http.statusCode) }
        return data
    }

    private static func server(_ raw: String) throws -> URL {
        guard var parts = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = parts.host?.lowercased(), !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, ["", "/"].contains(parts.path)
        else { throw NativeAccountError.address }
        var supported = parts.scheme?.lowercased() == "https"
        #if DEBUG
        supported = supported || (parts.scheme == "http" && ["127.0.0.1", "localhost", "[::1]"].contains(host))
        #endif
        guard supported else { throw NativeAccountError.address }
        parts.path = ""
        guard let url = parts.url else { throw NativeAccountError.address }
        return url
    }
}

@MainActor
struct OnlineWorkspace {
    let workspace: Workspace
    let client: any SessionsClient
    let close: () async -> Void
}

private func openDisplay(_ value: JSON?, grant: JSON, device: String, session: String, slot: String) -> JSON? {
    guard value?["mode"]?.string == "sealed", let keyID = value?["keyId"]?.string, keyID == grant["keyId"]?.string,
          let encoded = value?["payload"]?.string, let sealed = base64URL(encoded),
          let keyText = grant["key"]?.string, let key = base64URL(keyText),
          let box = try? AES.GCM.SealedBox(combined: sealed) else { return nil }
    let aad = Data(["aa-e2ee/1.0", "display", device, session, slot, keyID].joined(separator: "\u{0}").utf8)
    return (try? AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)).flatMap { try? JSON.decode($0) }
}

private func base64URL(_ value: String) -> Data? {
    let text = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    return Data(base64Encoded: text + String(repeating: "=", count: (4 - text.count % 4) % 4))
}


private nonisolated func passwordVerifier(_ password: String, salt: String) throws -> String {
    let raw = Array(password.utf8)
    let saltBytes = Array(salt.utf8)
    var output = [UInt8](repeating: 0, count: 32)
    let length = output.count
    let status = raw.withUnsafeBufferPointer { bytes in
        let password = bytes.baseAddress.map { UnsafeRawPointer($0).assumingMemoryBound(to: Int8.self) }
        return CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), password, bytes.count, saltBytes, saltBytes.count,
                                  CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), 120_000, &output, length)
    }
    guard status == kCCSuccess else { throw NativeAccountError.invalidResponse }
    return Data(output).base64EncodedString().replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}
