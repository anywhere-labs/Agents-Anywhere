import Foundation
import Testing
@testable import ClientCore

@Suite struct ChatLayoutStabilityTests {
    @Test func repeatedLayoutQueriesReuseMeasurementUntilContentChanges() {
        var cache = MarkdownMeasurementCache()
        var calls = 0
        for _ in 0..<120 {
            let size = cache.size(proposedWidth: 354) {
                calls += 1
                return CGSize(width: 354, height: 800)
            }
            #expect(size.height == 800)
        }
        #expect(calls == 1)
        cache.invalidate()
        let appended = cache.size(proposedWidth: 354) {
            calls += 1
            return CGSize(width: 354, height: 840)
        }
        #expect(calls == 2)
        #expect(appended.height == 840)
    }

    @Test func measurementProbesAndRotationCannotReuseAnotherWidthsHeight() {
        var cache = MarkdownMeasurementCache()
        for (width, height): (CGFloat?, CGFloat) in [(354, 800), (nil, 40), (0, 2000), (700, 400)] {
            #expect(cache.size(proposedWidth: width) { CGSize(width: width ?? 1000, height: height) }.height == height)
        }
        #expect(cache.size(proposedWidth: 354) { Issue.record("Lost the measured phone width"); return .zero }.height == 800)
        cache.invalidate()
        #expect(cache.size(proposedWidth: 354) { CGSize(width: 354, height: 1000) }.height == 1000)
    }

    @Test func intrinsicWidthOscillationCannotChangeTheColumnOrItsHeightReservation() {
        var sizing = MarkdownBlockSizing()
        let width = CGFloat(1063) / 3
        let height = CGFloat(352) / 3
        for intrinsicWidth in [347, width, 347, width, 347, width] {
            let result = sizing.size(proposedWidth: width,
                naturalSize: CGSize(width: intrinsicWidth, height: height), displayScale: 3)
            #expect(result == CGSize(width: width, height: height))
        }
        // A fragment can briefly lose a line while its asynchronous text layout
        // refreshes. Changing its intrinsic width must not reset that reservation.
        let shorter = sizing.size(proposedWidth: width,
            naturalSize: CGSize(width: 347, height: height - 24), displayScale: 3)
        #expect(shorter.height == height)
    }

    @Test func layoutProbesDoNotPoisonTheHeightForTheVisibleColumn() {
        var sizing = MarkdownBlockSizing()
        _ = sizing.size(proposedWidth: 354, naturalSize: CGSize(width: 347, height: 118), displayScale: 3)
        for proposal: CGFloat? in [0, 1, nil, .infinity, 100] {
            _ = sizing.size(proposedWidth: proposal, naturalSize: CGSize(width: 90, height: 800), displayScale: 3)
        }
        let result = sizing.size(proposedWidth: 354, naturalSize: CGSize(width: 354, height: 0), displayScale: 3)
        #expect(result == CGSize(width: 354, height: 118))
    }

    @Test func actualSplitWidthChangesReflowImmediatelyInBothDirections() {
        var sizing = MarkdownBlockSizing()
        let narrow = sizing.size(proposedWidth: 350, naturalSize: CGSize(width: 340, height: 240), displayScale: 2)
        let wide = sizing.size(proposedWidth: 700, naturalSize: CGSize(width: 690, height: 120), displayScale: 2)
        let narrowAgain = sizing.size(proposedWidth: 350, naturalSize: CGSize(width: 345, height: 240), displayScale: 2)
        #expect(narrow == narrowAgain)
        #expect(wide == CGSize(width: 700, height: 120))
        #expect(narrow == CGSize(width: 350, height: 240))
    }

    @Test func streamingGrowsAndARecreatedLayoutCanShrink() {
        var sizing = MarkdownBlockSizing()
        for height: CGFloat in [24, 48, 0, 72, 48] {
            let result = sizing.size(proposedWidth: 350, naturalSize: CGSize(width: 300, height: height), displayScale: 3)
            #expect(result.height >= height)
        }
        #expect(sizing.size(proposedWidth: 350, naturalSize: .zero, displayScale: 3).height == 72)
        // A font environment change or authoritative replacement recreates the
        // layout cache; the old height is not a permanent gap in corrected text.
        sizing = MarkdownBlockSizing()
        #expect(sizing.size(proposedWidth: 350, naturalSize: CGSize(width: 300, height: 24), displayScale: 3).height == 24)
    }

    @Test func statusRecoveryDoesNotInventOfflineOrKeepCachedActivity() throws {
        let chat = makeChat()
        defer { chat.repository.reset() }
        try update(chat, status: .running, fresh: false)
        #expect(chat.headerStatus == .syncing)
        try update(chat, status: .running, fresh: false,
            failure: V2ClientFailure(kind: .invalidResponse, message: "Invalid data"))
        #expect(chat.headerStatus == nil)
        try update(chat, status: .idle)
        #expect(chat.headerStatus == nil)
        try update(chat, status: .running)
        #expect(chat.headerStatus == nil)
        #expect(chat.sendingPlaceholder == "Agent 正在处理任务…")
        try update(chat, status: .stopping)
        #expect(chat.headerStatus == .stopping)
        try update(chat, status: .waitingApproval)
        #expect(chat.headerStatus == .waitingForResponse)
    }

    @Test func actualOfflineStateTakesPriorityOverCachedRuntimeAndSync() throws {
        let chat = makeChat()
        defer { chat.repository.reset() }
        try update(chat, status: .waitingApproval, fresh: false, networkOffline: true)
        #expect(chat.headerStatus == .networkOffline)
        try update(chat, status: .running, fresh: false, deviceOffline: true)
        #expect(chat.headerStatus == .deviceOffline)
        try update(chat, status: .idle, connection: .reconnecting)
        #expect(chat.headerStatus == .syncing)
        try update(chat, status: .idle, connection: .offline)
        #expect(chat.headerStatus == .networkOffline)
    }

    @Test func runtimeReasonRemainsAvailableWithoutAddingAMessage() throws {
        let chat = makeChat()
        defer { chat.repository.reset() }
        try update(chat, status: .blocked, reason: "等待设备上的登录流程")
        #expect(chat.headerStatus == .information("等待设备上的登录流程"))
        #expect(chat.headerStatus?.detail == "等待设备上的登录流程")
    }

    private func makeChat() -> SessionChatModel {
        let http = TestHTTPTransport()
        let repo = repository(transport: http)
        return SessionChatModel(session: repo.session(id: "session"), repository: repo,
            attachments: .init(attachmentAPI: V2AttachmentAPI(transport: http)))
    }

    private func update(_ chat: SessionChatModel, status: V2RuntimeStatus, fresh: Bool = true,
        networkOffline: Bool = false, deviceOffline: Bool = false,
        connection: V2SessionConnectionState = .connected, failure: V2ClientFailure? = nil, reason: String? = nil) throws {
        var raw = try fixtureObject("snapshot")
        var state = raw["state"] as! [String: Any]
        state["status"] = status.rawValue
        state["statusReason"] = reason
        raw["state"] = state
        var meta = raw["session"] as! [String: Any]
        meta["connectorStatus"] = deviceOffline ? "offline" : "online"
        raw["session"] = meta
        var data = V2SessionData(snapshot: try decode(raw))
        data.liveStateIsFresh = fresh
        data.notices = []
        chat.session.update(V2SessionObservation(sessionId: "session", data: data, connection: connection, error: failure),
            network: V2NetworkStatus(availability: networkOffline ? .offline : .online))
    }
}
