import Foundation
import Synchronization
import Testing
@testable import ClientCore

/// Encrypted mode: display envelopes in the session list and auto-assignment by decrypted `cwd`.
@Suite @MainActor struct SessionDisplayTests {
    private static let key = Data((0..<32).map { UInt8($0) })
    private static let otherKey = Data((0..<32).map { UInt8(255 - $0) })
    private static let keyId = "dk_1"

    private func resolver(_ key: Data? = SessionDisplayTests.key, keyId: String = SessionDisplayTests.keyId) -> V2SessionDisplayResolver {
        V2SessionDisplayResolver { deviceId in
            guard deviceId == "device", let key else { return nil }
            return (keyId, key)
        }
    }

    private func sealed(_ fields: [String: Any], session: String = "session", device: String = "device",
                        slot: E2EEDisplaySlot, keyId: String = SessionDisplayTests.keyId, key: Data = SessionDisplayTests.key) throws -> [String: Any] {
        let ad = try E2EEFormats.displayEnvelopeAD(deviceId: device, sessionId: session, slot: slot, keyId: keyId)
        let payload = try E2EEFormats.sealDisplayEnvelope(key: key, ad: ad, plaintext: JSONSerialization.data(withJSONObject: fields))
        return ["mode": "sealed", "keyId": keyId, "payload": payload]
    }

    private func sessionObject(id: String = "session", project: String? = nil, title: Any = NSNull(), cwd: Any = NSNull(),
                               device: [String: Any]? = nil, user: [String: Any]? = nil, updatedSeq: Int = 20) throws -> [String: Any] {
        var object = (try fixtureObject("sessions")["sessions"] as! [[String: Any]])[0]
        object["id"] = id; object["projectId"] = project ?? NSNull(); object["title"] = title; object["cwd"] = cwd
        object["updatedSeq"] = updatedSeq
        if let device { object["displayDevice"] = device }
        if let user { object["displayUser"] = user }
        return object
    }

    private func meta(_ object: [String: Any]) throws -> V2SessionMeta { try decode(object) }

    // MARK: Envelopes

    @Test func sessionsWithoutEnvelopesAreUnchanged() throws {
        let session = try meta(try sessionObject(title: "Task", cwd: "/workspace"))
        #expect(session.displayDevice == nil && session.displayUser == nil)
        #expect(resolver().resolve(session) == session)
    }

    @Test func sealedEnvelopesOpenWithTheirSlotAndTheSessionsDevice() throws {
        let device = try sealed(["title": "Device title", "cwd": "/work/app", "preview": "hi", "future": 1], slot: .device)
        let session = try resolver().resolve(meta(try sessionObject(device: device)))
        #expect(session.title == "Device title" && session.cwd == "/work/app" && session.displayLocked == nil)

        // The same ciphertext under the other slot, another session or another device does not open.
        let swapped = try resolver().resolve(meta(try sessionObject(user: device)))
        #expect(swapped.title == V2SessionDisplayResolver.lockedTitle && swapped.displayLocked == true)
        let moved = try sealed(["title": "x", "cwd": "/x"], session: "other", slot: .device)
        #expect(try resolver().resolve(meta(try sessionObject(device: moved))).cwd == nil)
        let otherDevice = try sealed(["title": "x"], device: "laptop", slot: .device)
        #expect(try resolver().resolve(meta(try sessionObject(device: otherDevice))).title == V2SessionDisplayResolver.lockedTitle)
    }

    @Test func plainEnvelopesAreObjectsAndKeepServerFieldsTheyOmit() throws {
        let plain = try resolver(nil).resolve(meta(try sessionObject(title: "Server", cwd: "/server",
            device: ["mode": "plain", "payload": ["title": "Device", "cwd": "/device"]], user: ["mode": "plain", "payload": ["title": "Mine"]])))
        #expect(plain.title == "Mine" && plain.cwd == "/device" && plain.displayLocked == nil)
        let partial = try resolver(nil).resolve(meta(try sessionObject(title: "Server", cwd: "/server",
            device: ["mode": "plain", "payload": ["preview": "p"]])))
        #expect(partial.title == "Server" && partial.cwd == "/server")
        let unknownMode = try resolver().resolve(meta(try sessionObject(title: "Server", cwd: "/server",
            device: ["mode": "future", "payload": "abc"])))
        #expect(unknownMode.title == "Server" && unknownMode.cwd == "/server")
        let jsonString = try resolver(nil).resolve(meta(try sessionObject(title: "Server",
            user: ["mode": "plain", "payload": "{\"title\":\"Text\"}"])))
        #expect(jsonString.title == "Text")
    }

    @Test func unknownModesCountAsAbsentEnvelopes() throws {
        let future: [String: Any] = ["mode": "future", "keyId": Self.keyId, "payload": "abc"]
        let alone = try meta(try sessionObject(title: "Server", cwd: "/server", device: future, user: future))
        let resolvedAlone = resolver().resolve(alone)
        #expect(resolvedAlone.title == "Server" && resolvedAlone.cwd == "/server" && resolvedAlone.displayLocked == nil)
        #expect(alone.displayDevice?.mode == .unknown)
        // Next to a plain envelope: still normal mode, as if the unknown one were not there.
        let withPlain = try resolver(nil).resolve(meta(try sessionObject(title: "Server", cwd: "/server",
            device: future, user: ["mode": "plain", "payload": ["title": "Mine"]])))
        let plainOnly = try resolver(nil).resolve(meta(try sessionObject(title: "Server", cwd: "/server",
            user: ["mode": "plain", "payload": ["title": "Mine"]])))
        #expect(withPlain.title == plainOnly.title && withPlain.cwd == plainOnly.cwd && withPlain.displayLocked == nil)
        // Next to a sealed envelope: encrypted mode, the unknown slot neither locks nor feeds anything.
        let sealedUser = try resolver().resolve(meta(try sessionObject(title: "Server", cwd: "/server",
            device: future, user: try sealed(["title": "Renamed"], slot: .user))))
        #expect(sealedUser.title == "Renamed" && sealedUser.cwd == nil && sealedUser.displayLocked == nil)
        let sealedDevice = try resolver().resolve(meta(try sessionObject(title: "Server", cwd: "/server",
            device: try sealed(["title": "Device", "cwd": "/work"], slot: .device), user: future)))
        #expect(sealedDevice.title == "Device" && sealedDevice.cwd == "/work" && sealedDevice.displayLocked == nil)
    }

    @Test func sealedEnvelopesWinOverPlainOnes() throws {
        let device = try sealed(["title": "Sealed", "cwd": "/sealed"], slot: .device)
        let session = try resolver().resolve(meta(try sessionObject(title: "Server", cwd: "/server", device: device,
            user: ["mode": "plain", "payload": ["title": "Plain rename"]])))
        #expect(session.title == "Sealed" && session.cwd == "/sealed" && session.displayLocked == nil)
        let mixed = try resolver().resolve(meta(try sessionObject(device: ["mode": "plain", "payload": ["title": "P", "cwd": "/p"]],
            user: try sealed(["title": "Renamed"], slot: .user))))
        #expect(mixed.title == "Renamed" && mixed.cwd == nil)
    }

    @Test func sealedSessionsNeverFallBackToServerPlaintext() throws {
        let device = try sealed(["preview": "only"], slot: .device)
        let session = try resolver().resolve(meta(try sessionObject(title: "Server", cwd: "/server", device: device)))
        #expect(session.title == nil && session.cwd == nil && session.displayLocked == nil)
    }

    @Test func missingOldOrBrokenKeysShowTheLockedPlaceholder() throws {
        let device = try sealed(["title": "Secret", "cwd": "/secret"], slot: .device)
        let cases: [(V2SessionDisplayResolver, [String: Any])] = [
            (resolver(nil), device),                                       // not paired / no key
            (resolver(keyId: "dk_2"), device),                             // older keyId than the stored epoch
            (resolver(Self.otherKey), device),                             // same keyId, wrong key
            (resolver(), device.merging(["payload": "AAAA"]) { $1 }),      // truncated payload
            (resolver(), device.filter { $0.key != "keyId" }),             // keyId missing
            (resolver(), device.merging(["payload": ["title": "x"]]) { $1 }), // sealed but not a string
        ]
        for (resolver, envelope) in cases {
            let session = try resolver.resolve(meta(try sessionObject(title: "Server", cwd: "/server", device: envelope)))
            #expect(session.title == V2SessionDisplayResolver.lockedTitle)
            #expect(session.cwd == nil && session.displayLocked == true)
        }
    }

    @Test func userTitleWinsAndAnyLockedEnvelopeLocksTheSession() throws {
        let device = try sealed(["title": "Device", "cwd": "/work"], slot: .device)
        let user = try sealed(["title": "Renamed"], slot: .user)
        let renamed = try resolver().resolve(meta(try sessionObject(device: device, user: user)))
        #expect(renamed.title == "Renamed" && renamed.cwd == "/work" && renamed.displayLocked == nil)
        let blank = try sealed(["title": "  "], slot: .user)
        #expect(try resolver().resolve(meta(try sessionObject(device: device, user: blank))).title == "Device")
        // A rename sealed with an older key: never fall back to the device's original title,
        // but the device's cwd still shows.
        let oldUser = try sealed(["title": "Renamed"], slot: .user, keyId: "dk_0", key: Self.otherKey)
        let lockedUser = try resolver().resolve(meta(try sessionObject(device: device, user: oldUser)))
        #expect(lockedUser.title == V2SessionDisplayResolver.lockedTitle && lockedUser.cwd == "/work" && lockedUser.displayLocked == true)
        // Only the rename, and it does not open.
        let onlyUser = try resolver().resolve(meta(try sessionObject(title: "Server", user: oldUser)))
        #expect(onlyUser.title == V2SessionDisplayResolver.lockedTitle && onlyUser.cwd == nil && onlyUser.displayLocked == true)
        // The device envelope does not open but the rename does: the user's title, no cwd, still locked.
        let lockedDevice = try sealed(["title": "Device", "cwd": "/work"], slot: .device, keyId: "dk_0", key: Self.otherKey)
        let lockedCwd = try resolver().resolve(meta(try sessionObject(device: lockedDevice, user: user)))
        #expect(lockedCwd.title == "Renamed" && lockedCwd.cwd == nil && lockedCwd.displayLocked == true)
        // Neither opens.
        let both = try resolver().resolve(meta(try sessionObject(device: lockedDevice, user: oldUser)))
        #expect(both.title == V2SessionDisplayResolver.lockedTitle && both.cwd == nil && both.displayLocked == true)
    }

    @Test func failuresAreRetriedOnceAKeyArrives() throws {
        let stored = Mutex<Data?>(nil)
        let resolver = V2SessionDisplayResolver { _ in stored.withLock { $0 }.map { (Self.keyId, $0) } }
        let session = try meta(try sessionObject(device: try sealed(["title": "Secret"], slot: .device)))
        #expect(resolver.resolve(session).title == V2SessionDisplayResolver.lockedTitle)
        stored.withLock { $0 = Self.key }
        #expect(resolver.resolve(session).title == "Secret")
        // Opened payloads are cached: the same envelope opens without asking for the key again.
        stored.withLock { $0 = nil }
        #expect(resolver.resolve(session).title == "Secret")
        resolver.clearCache()
        #expect(resolver.resolve(session).title == V2SessionDisplayResolver.lockedTitle)
    }

    @Test func trustStoreChangesNotifyObserversAndFeedTheResolver() throws {
        let trust = ClientTrustStore(storage: E2EEMemoryStorage(), scope: "test")
        let calls = Mutex(0)
        let observer = trust.observeDevices { calls.withLock { $0 += 1 } }
        let resolver = V2SessionDisplayResolver(trust: trust)
        let session = try meta(try sessionObject(device: try sealed(["title": "Secret"], slot: .device, keyId: "dk_2")))
        #expect(resolver.resolve(session).title == V2SessionDisplayResolver.lockedTitle)

        let grant = { (keyId: String, epoch: Int) in
            E2EEDirectoryKeyGrant(deviceId: "device", keyId: keyId, epoch: epoch, key: E2EEFormats.base64url(Self.key))
        }
        try trust.savePairing(.init(deviceId: "device", clientId: "c", devicePub: Data(repeating: 9, count: 32),
                                    grantedAt: "2026-11-17T00:00:00Z", directoryKey: grant("dk_1", 1)))
        #expect(calls.withLock { $0 } == 1)
        #expect(resolver.resolve(session).title == V2SessionDisplayResolver.lockedTitle) // still an older epoch here
        #expect(try trust.updateDirectoryKey(grant("dk_2", 2)))
        #expect(!(try trust.updateDirectoryKey(grant("dk_2", 2))))
        #expect(calls.withLock { $0 } == 2)
        #expect(resolver.resolve(session).title == "Secret")
        try trust.forget("device")
        #expect(calls.withLock { $0 } == 3)
        trust.removeObserver(observer)
        try trust.forget("device")
        #expect(calls.withLock { $0 } == 3)
    }

    // MARK: Project matching

    private func project(_ id: String, _ path: String, connector: String = "device") throws -> V2Project {
        var object = (try fixtureObject("projects")["projects"] as! [[String: Any]])[0]
        object["id"] = id; object["workspacePath"] = path; object["connectorId"] = connector
        return try decode(object)
    }

    @Test func projectsMatchExactlyThenByTheLongestWholeSegmentPrefix() throws {
        let projects = [try project("root", "/a"), try project("nested", "/a/b/"), try project("sibling", "/a/bc"),
                        try project("elsewhere", "/a/b/c", connector: "laptop"), try project("app", "/work/app")]
        func match(_ cwd: String, _ list: [V2Project]? = nil) -> String? {
            V2SessionProjectMatch.project(forCwd: cwd, connectorID: "device", projects: list ?? projects)?.id
        }
        #expect(match("/a/b") == "nested")
        #expect(match("  /a/b/  ") == "nested")
        #expect(match("/a/b//") == "nested")
        #expect(match("/a/b/c/d") == "nested")       // the other device's /a/b/c is not considered
        #expect(match("/a/bc/x") == "sibling")
        #expect(match("/a/bcd") == "root")          // /a/bc is not a segment prefix of /a/bcd
        #expect(match("/work/apple") == nil)        // /work/app is not a segment prefix of /work/apple
        #expect(match("/work/app/src") == "app")
        #expect(match("/A/b") == nil)               // POSIX paths are case-sensitive
        #expect(match("/ab") == nil)
        #expect(match("   ") == nil)
        #expect(match("/anything", [try project("slash", "/")]) == "slash")

        let windows = [try project("w", "C:\\Users\\Me\\Repo\\"), try project("w2", "c:/users/me"), try project("posix", "/c/users")]
        #expect(match("c:\\USERS\\me\\repo\\src", windows) == "w")
        #expect(match("C:/Users/ME/", windows) == "w2")             // `/` counts as `\`, case-insensitive
        #expect(match("C:\\Users\\Mean", windows) == nil)
        #expect(match("D:\\Users\\Me", windows) == nil)
        #expect(match("D:\\Work", [try project("drive", "d:\\")]) == "drive")
        #expect(V2SessionProjectMatch.normalize("  C:/Work/App/ ") == "c:\\work\\app")
        #expect(V2SessionProjectMatch.normalize("/Work/App/") == "/Work/App")
    }

    // MARK: Auto-assignment

    private func repository(_ http: TestHTTPTransport, resolver: V2SessionDisplayResolver? = nil) -> V2DashboardRepository {
        let repository = V2DashboardRepository(service: .init(connectorAPI: V2ConnectorAPI(transport: http), projectAPI: .init(transport: http),
            sessionAPI: V2SessionAPI(transport: http), realtimeAPI: TestRealtimeAPI()))
        repository.displayResolver = resolver ?? self.resolver()
        return repository
    }

    private func dashboard(_ sessions: [[String: Any]], projects: [V2Project]? = nil) throws -> V2DashboardSnapshot {
        var value = try fixtureObject("dashboard")
        value["sessions"] = sessions
        if let projects {
            value["projects"] = try projects.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) }
        }
        return try decode(value)
    }

    private func patches(_ http: TestHTTPTransport) -> [TestHTTPTransport.Call] {
        http.calls.filter { $0.method == .patch && $0.path.hasSuffix("/meta") }
    }

    @Test func decryptedCwdAssignsTheSessionOncePerRun() async throws {
        let http = TestHTTPTransport()
        let device = try sealed(["title": "Imported", "cwd": "/workspace/app"], slot: .device)
        http.respond = { call in
            guard call.method == .patch else { return try http.defaultResponse(call) }
            let session = try self.sessionObject(project: "project", device: device, updatedSeq: 21)
            return try JSONSerialization.data(withJSONObject: ["session": session, "serverTime": "2026-11-17T00:00:00Z"])
        }
        let store = repository(http)
        let snapshot = try dashboard([try sessionObject(device: device)])
        store.apply(snapshot)
        #expect(store.sessions.first?.title == "Imported" && store.sessions.first?.cwd == "/workspace/app")
        try await eventually { store.sessions.first?.projectId == "project" }
        #expect(patches(http).count == 1)
        #expect(patches(http).first?.path.hasSuffix("/sessions/session/meta") == true)
        #expect(patches(http).first?.body == .object(["projectId": .string("project")]))
        // The PATCH answer went through the same display path.
        #expect(store.sessions.first?.title == "Imported")

        // A later push that still says "no project" does not try again in this run.
        store.apply(try dashboard([try sessionObject(device: device, updatedSeq: 30)]))
        try await Task.sleep(for: .milliseconds(20))
        #expect(patches(http).count == 1)
    }

    @Test func assignmentFailuresStaySilentAndAreNotRetried() async throws {
        for (status, code) in [(404, "project_not_found"), (422, "project_workspace_mismatch")] {
            let http = TestHTTPTransport()
            http.respond = { call in
                if call.method == .patch { throw HTTPError.server(statusCode: status, message: code) }
                return try http.defaultResponse(call)
            }
            let store = repository(http)
            let device = try sealed(["cwd": "/workspace"], slot: .device)
            store.apply(try dashboard([try sessionObject(device: device)]))
            try await eventually { patches(http).count == 1 }
            try await Task.sleep(for: .milliseconds(20))
            #expect(store.error == nil && store.sessions.first?.projectId == nil)
            store.upsert([try meta(try sessionObject(device: device, updatedSeq: 40))])
            store.apply(try dashboard([try sessionObject(device: device, updatedSeq: 41)]))
            try await Task.sleep(for: .milliseconds(20))
            #expect(patches(http).count == 1)
        }
    }

    @Test func onlyOpenedSealedCwdsWithAMatchingProjectAreAssigned() async throws {
        let http = TestHTTPTransport()
        let store = repository(http, resolver: resolver(keyId: "dk_other"))
        store.apply(try dashboard([
            try sessionObject(id: "plain", cwd: "/workspace", device: ["mode": "plain", "payload": ["cwd": "/workspace"]]),
            try sessionObject(id: "legacy", cwd: "/workspace"),
            try sessionObject(id: "locked", device: try sealed(["cwd": "/workspace"], session: "locked", slot: .device)),
        ]))
        try await Task.sleep(for: .milliseconds(20))
        #expect(patches(http).isEmpty)
        #expect(store.sessions.first { $0.id == "locked" }?.title == V2SessionDisplayResolver.lockedTitle)

        let unmatched = repository(http)
        unmatched.apply(try dashboard([try sessionObject(device: try sealed(["cwd": "/elsewhere"], slot: .device))]))
        let assigned = repository(http)
        assigned.apply(try dashboard([try sessionObject(project: "project", device: try sealed(["cwd": "/workspace"], slot: .device))]))
        try await Task.sleep(for: .milliseconds(20))
        #expect(patches(http).isEmpty)
    }

    @Test func aSessionWithoutAMatchIsAssignedOnceTheProjectExists() async throws {
        let http = TestHTTPTransport()
        http.respond = { call in
            if call.method == .patch { throw HTTPError.server(statusCode: 422, message: "project_workspace_mismatch") }
            return try http.defaultResponse(call)
        }
        let store = repository(http)
        let device = try sealed(["cwd": "/elsewhere/app"], slot: .device)
        store.apply(try dashboard([try sessionObject(device: device)]))
        try await Task.sleep(for: .milliseconds(20))
        #expect(patches(http).isEmpty)

        store.upsertProject(try project("later", "/elsewhere"))
        try await eventually { patches(http).count == 1 }
        #expect(patches(http).first?.body == .object(["projectId": .string("later")]))
        store.upsert([try meta(try sessionObject(device: device, updatedSeq: 21))])
        try await Task.sleep(for: .milliseconds(20))
        #expect(patches(http).count == 1)
    }

    @Test func aLockedRenameStillAssignsByTheDevicesCwdButALockedDeviceDoesNot() async throws {
        let http = TestHTTPTransport()
        http.respond = { call in
            if call.method == .patch { throw HTTPError.server(statusCode: 404, message: "project_not_found") }
            return try http.defaultResponse(call)
        }
        let store = repository(http)
        let oldKey = Self.otherKey
        store.apply(try dashboard([
            try sessionObject(id: "renamed", device: try sealed(["cwd": "/workspace"], session: "renamed", slot: .device),
                              user: try sealed(["title": "R"], session: "renamed", slot: .user, keyId: "dk_0", key: oldKey)),
            try sessionObject(id: "deviceLocked", device: try sealed(["cwd": "/workspace"], session: "deviceLocked", slot: .device, keyId: "dk_0", key: oldKey),
                              user: try sealed(["title": "R"], session: "deviceLocked", slot: .user)),
        ]))
        #expect(store.sessions.first { $0.id == "renamed" }?.cwd == "/workspace")
        #expect(store.sessions.first { $0.id == "deviceLocked" }?.title == "R")
        try await eventually { patches(http).count == 1 }
        try await Task.sleep(for: .milliseconds(20))
        #expect(patches(http).count == 1 && patches(http).first?.path.hasSuffix("/sessions/renamed/meta") == true)
    }

    @Test func aNewDirectoryKeyRedisplaysTheListAndThenAssigns() async throws {
        let http = TestHTTPTransport()
        http.respond = { call in
            if call.method == .patch { throw HTTPError.server(statusCode: 404, message: "project_not_found") }
            return try http.defaultResponse(call)
        }
        let stored = Mutex<Data?>(nil)
        let store = repository(http, resolver: V2SessionDisplayResolver { _ in stored.withLock { $0 }.map { (Self.keyId, $0) } })
        store.apply(try dashboard([try sessionObject(device: try sealed(["title": "Later", "cwd": "/workspace"], slot: .device))]))
        #expect(store.sessions.first?.title == V2SessionDisplayResolver.lockedTitle)
        try await Task.sleep(for: .milliseconds(20))
        #expect(patches(http).isEmpty)

        stored.withLock { $0 = Self.key }
        store.redisplay()
        #expect(store.sessions.first?.title == "Later" && store.sessions.first?.displayLocked == nil)
        try await eventually { patches(http).count == 1 }
    }

    @Test func theSessionInventoryReadOpensEnvelopesToo() async throws {
        let http = TestHTTPTransport()
        let device = try sealed(["title": "From inventory", "cwd": "/workspace"], slot: .device)
        http.respond = { call in
            guard call.path.hasSuffix("/sessions/list") else { return try http.defaultResponse(call) }
            return try JSONSerialization.data(withJSONObject: ["sessions": [try self.sessionObject(project: "project", device: device)],
                                                               "serverTime": "2026-11-17T00:00:00Z"])
        }
        let store = repository(http)
        await store.refresh()
        #expect(store.sessions.first?.title == "From inventory" && store.sessions.first?.cwd == "/workspace")
        #expect(store.sessions.first?.displayDevice?.mode == .sealed)
    }

    @Test func theSessionPageShowsTheOpenedTitle() async throws {
        let http = TestHTTPTransport()
        let device = try sealed(["title": "Page title", "cwd": "/workspace"], slot: .device)
        http.respond = { call in
            guard call.path.hasSuffix("/snapshot") else { return try http.defaultResponse(call) }
            var value = try fixtureObject("snapshot")
            value["session"] = try self.sessionObject(device: device)
            return try JSONSerialization.data(withJSONObject: value)
        }
        let sessions = ClientCoreTests.repository(transport: http)
        sessions.displayResolver = resolver()
        defer { sessions.reset() }
        let model = sessions.session(id: "session")
        try await sessions.load(sessionId: "session")
        try await eventually { model.metadata != nil }
        #expect(model.metadata?.title == "Page title" && model.metadata?.cwd == "/workspace")
    }
}
