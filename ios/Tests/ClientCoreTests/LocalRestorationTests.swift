import Foundation
import Testing
@testable import ClientCore

@Suite @MainActor struct LocalRestorationTests {
    private func location() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("aa-local-tests-" + UUID().uuidString) }
    private func repo(_ http: TestHTTPTransport, local: V2LocalStore) -> V2SessionRepository {
        let runtime = V2RuntimeAPI(transport: http)
        return .init(scope: .init(serverURL: URL(string: "https://example.test")!, accountID: "account"),
            detail: .init(sessionAPI: V2SessionAPI(transport: http), runtimeAPI: runtime, realtimeAPI: TestRealtimeAPI()),
            interactions: .init(runtimeAPI: runtime), localStore: local)
    }
    @Test func launchIdentityAndNavigationAreBoundToServerAccountAndCredential() throws {
        let name = "aa-restoration-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!; defer { defaults.removePersistentDomain(forName: name) }
        let store = V2RestorationStore(defaults: defaults)
        let server = URL(string: "https://example.test")!
        let profile: AuthMe = try fixture("profile")
        let scope = V2ClientScope(serverURL: server, accountID: profile.userId)
        store.save(profile: profile, server: server, token: "first-token")
        store.save(selection: .session("last-session"), in: scope)
        #expect(store.profile(server: server, token: "first-token")?.userId == profile.userId)
        #expect(store.profile(server: server, token: "different-token") == nil)
        #expect(store.profile(server: URL(string: "https://other.test")!, token: "first-token") == nil)
        #expect(store.selection(in: scope) == .session("last-session"))
        #expect(store.selection(in: .init(serverURL: server, accountID: "different")) == .newSession)
        store.clear(scope: scope)
        #expect(store.profile(server: server, token: "first-token") == nil)
        #expect(store.selection(in: scope) == .newSession)
    }
    @Test func coldOfflineLaunchReadsMessagesAndDraftWithoutAnyNetworkOrLivePermissions() async throws {
        let url = location(); defer { try? FileManager.default.removeItem(at: url) }
        let store = V2LocalStore(directory: url); let first = repo(TestHTTPTransport(), local: store)
        _ = try await first.load(sessionId: "session")
        first.session(id: "session").draft = "离线草稿"
        await first.flushCache(); first.reset()
        let http = TestHTTPTransport(); let restored = repo(http, local: V2LocalStore(directory: url))
        restored.updateConnectivity(.init(availability: .offline))
        let value = try await restored.load(sessionId: "session")
        let model = restored.session(id: "session")
        #expect(http.calls.isEmpty && value.items.first?.displayText == "Hello")
        #expect(model.draft == "离线草稿" && !model.runtime.isFresh && !model.canSend)
        let chat = SessionChatModel(session: model, repository: restored, attachments: .init(attachmentAPI: V2AttachmentAPI(transport: http)))
        #expect(!chat.isOpeningPrepared && chat.timeline.rows.isEmpty)
        await chat.prepareOpening()
        #expect(chat.isOpeningReady && chat.timeline.rows.count == 1)
        #expect(http.calls.isEmpty)
        #expect(chat.headerStatus == .networkOffline)
        restored.reset(); await store.close(removing: true)
    }
    @Test func openingLargeDiskCacheOfflineStillStartsWithOnePage() async throws {
        let url = location(); defer { try? FileManager.default.removeItem(at: url) }
        let store = V2LocalStore(directory: url)
        let http = TestHTTPTransport()
        let first = repo(http, local: store)
        let data = V2SessionData(snapshot: try snapshot(items: (1...300).map {
            try itemObject(id: "item-\($0)", order: $0)
        }))
        let session = first.session(id: "session")
        session.draft = "Keep my draft"
        await store.saveSession(V2SessionArchive(data: data, model: session))
        let restored = repo(http, local: store)
        restored.updateConnectivity(.init(availability: .offline))
        let opening = try await restored.open(sessionId: "session")
        #expect(opening.items.map(\.orderSeq) == Array(201...300))
        #expect(opening.hasOlderItems && !opening.hasNewerItems && http.calls.isEmpty)
        #expect(restored.session(id: "session").draft == "Keep my draft")
        restored.reset(); first.reset(); await store.close(removing: true)
    }
    @Test func corruptionEvictionAndSignedOutWritesDoNotTrapTheReader() async throws {
        let url = location(); defer { try? FileManager.default.removeItem(at: url) }
        let store = V2LocalStore(directory: url, maximumSessions: 1)
        let http = TestHTTPTransport(); let first = repo(http, local: store)
        let data = try await first.load(sessionId: "session")
        let archive = V2SessionArchive(data: data, model: first.session(id: "session"))
        await store.saveSession(archive)
        await store.removeSession("session"); await store.saveSession(archive)
        #expect(await store.session("session") == nil)
        await store.close(removing: true); await store.saveSession(archive)
        #expect(!FileManager.default.fileExists(atPath: url.path))
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        try Data("{broken".utf8).write(to: url.appendingPathComponent("dashboard.json"))
        let other = V2LocalStore(directory: url)
        #expect(await other.dashboard() == nil)
        first.reset()
    }
    @Test func restoredPendingSendIsUncertainAndEchoReconcilesWithoutReplay() async throws {
        let url = location(); defer { try? FileManager.default.removeItem(at: url) }
        let local = V2LocalStore(directory: url); let first = repo(TestHTTPTransport(), local: local)
        _ = try await first.load(sessionId: "session")
        first.session(id: "session").stage(.init(id: "client", content: "pending", attachmentIDs: []))
        await first.flushCache(); first.reset()
        let http = TestHTTPTransport(); let restored = repo(http, local: V2LocalStore(directory: url))
        restored.updateConnectivity(.init(availability: .offline)); _ = try await restored.load(sessionId: "session")
        let model = restored.session(id: "session")
        guard case .uncertain = model.pendingMessages.first?.delivery else { Issue.record("An interrupted send must be uncertain"); return }
        model.confirmEcho(try decode(itemObject(clientID: "client"), as: V2TimelineItem.self))
        #expect(model.pendingMessages.isEmpty && http.calls.isEmpty)
        restored.reset()
    }
    @Test func restoredDashboardStaysReadableUntilTheCompleteInventoryReplacesIt() async throws {
        let url = location(); defer { try? FileManager.default.removeItem(at: url) }
        let local = V2LocalStore(directory: url); let http = TestHTTPTransport()
        let service = V2DashboardService(connectorAPI: V2ConnectorAPI(transport: http), projectAPI: .init(transport: http),
            sessionAPI: V2SessionAPI(transport: http), realtimeAPI: TestRealtimeAPI())
        let original = V2DashboardRepository(service: service, localStore: local)
        original.apply(try fixture("dashboard")); await original.flushCache(); original.invalidate()
        let restored = V2DashboardRepository(service: service, localStore: V2LocalStore(directory: url))
        await restored.restoreCache()
        #expect(restored.hasLoaded && !restored.isFresh && !restored.canWrite && !restored.sessions.isEmpty)
        var next = try fixtureObject("dashboard")
        next["sessions"] = []
        restored.apply(try decode(next))
        #expect(restored.isFresh && restored.sessions.isEmpty)
        restored.invalidate()
    }
    @Test func localCreationOpensImmediatelyAndBindsTheSameBubbleAndAttachmentToServerID() async throws {
        let http = TestHTTPTransport(); let local = V2LocalStore(directory: location())
        let store = repo(http, local: local)
        let project = try fixture("project", as: V2ProjectResponse.self).project
        let runtime: V2DeviceRuntime = try fixture("runtime")
        let file = ChatAttachment(id: "local-image", name: "photo.png", data: Data([1]), mediaType: "image/png", previewData: Data([2]))
        let submission = NewSessionSubmission(project: project, runtime: runtime, text: "看看这个", attachments: [file])
        store.stageCreation(submission)
        let observation = Task { for await _ in store.observe(sessionId: submission.session.id) { if Task.isCancelled { return } } }
        await Task.yield()
        #expect(http.calls.isEmpty)
        var response: V2SessionCreateResponse = try fixture("session")
        response.attachments = [.init(fileId: "remote-image", name: "photo.png", mediaType: "image/png", size: 1, sha256: "sha")]
        store.bindCreation(submission, response: response)
        let model = store.session(id: "session")
        #expect(model.pendingMessages.first === submission.pending)
        #expect(model.pendingMessages.first?.attachmentIDs == ["remote-image"])
        #expect(model.attachmentPreviews.resolve(submission.pending.attachments.map(\.content), clientID: submission.pending.id).first?.previewData == Data([2]))
        #expect(!store.cachedSessionIDs.contains(submission.session.id))
        observation.cancel(); await observation.value
        store.reset(); await local.close(removing: true)
    }
}
