import Foundation
import UserNotifications

private nonisolated enum NotificationKeys {
    static let sessionIDUserInfo = "agentsAnywhere.sessionId"
    static let permissionRequested = "agentsAnywhere.notificationsPermissionRequested"
}

/// App-level session notifications. Foreground users see questions on the
/// session page and inside the interaction dock, so the coordinator only
/// observes while backgrounded. When the scene enters the background it opens
/// its own session sockets (the dashboard snapshot channel carries no
/// runtime.notice.* or runtime.state.updated frames, so per-session WS is the
/// only event source) and raises local notifications for:
///
/// - open interaction notices (DSH questions/approvals), both ones already
///   waiting when backgrounding starts and ones that arrive later,
/// - running → idle transitions, reported as 任务完成 or, when a stopping
///   frame was observed inside the turn (best effort: iOS may suspend the
///   process before that short state is delivered), 任务已中断,
/// - running → error transitions ("任务失败", body prefers statusReason).
///
/// iOS suspends the process and its sockets shortly after backgrounding, so
/// delivery is limited to the background grace period while the app still
/// runs. Durable offline delivery requires a server-side APNs push path and
/// remains future work.
@MainActor
final class SessionNotificationCoordinator: NSObject {
    private static let maximumMonitoredSessions = 12

    var onOpenSession: ((V2SessionID) -> Void)?

    private var services: V2ClientServices?
    private var isInBackground = false
    private var isAuthorized = false
    private var monitors: [V2SessionID: Task<Void, Never>] = [:]
    /// Folded per-session turn state feeding the interrupted/completed verdict
    /// (see `SessionTurnOutcome`). Seeded from the background-entry snapshot so
    /// only transitions observed while backgrounded notify.
    private var turnOutcomes: [V2SessionID: SessionTurnOutcome] = [:]
    /// Kept across foreground/background cycles so re-entering the background
    /// does not re-raise the same open question. Cleared on account changes.
    private var notifiedInteractionIDs: Set<V2NoticeID> = []

    /// One permission prompt, ever, at the first successful sign-in.
    func requestAuthorizationIfNeeded() async {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: NotificationKeys.permissionRequested) else { return }
        defaults.set(true, forKey: NotificationKeys.permissionRequested)
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let granted = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) == true
        isAuthorized = granted
    }

    /// Bind to the signed-in account scope. Idempotent per service instance.
    func start(services: V2ClientServices) {
        guard self.services !== services else { return }
        suspendMonitoring()
        notifiedInteractionIDs.removeAll()
        self.services = services
        UNUserNotificationCenter.current().delegate = self
        if isInBackground { beginMonitoring(services: services) }
    }

    /// Sign-out teardown. Stale notifications would open a session that no
    /// longer belongs to this account scope, so remove them.
    func stop() {
        suspendMonitoring()
        notifiedInteractionIDs.removeAll()
        services = nil
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    }

    func setAppInBackground(_ background: Bool) {
        guard isInBackground != background else { return }
        isInBackground = background
        if background {
            guard let services else { return }
            Task { [weak self] in
                await self?.refreshAuthorizationStatus()
                guard let self else { return }
                beginMonitoring(services: services)
            }
        } else {
            suspendMonitoring()
        }
    }

    // MARK: - Background event source

    private func beginMonitoring(services: V2ClientServices) {
        // The authorization read can straddle a foreground transition or an
        // account switch; never attach monitors to a stale scope or phase.
        guard isInBackground, services === self.services, monitors.isEmpty else { return }
        let sessions = sessionsToMonitor(services)
        for session in sessions where session.status == .running {
            // A running session at backgrounding starts already has a turn in
            // flight; without this seed its completion would be silent.
            turnOutcomes[session.id] = .completed
        }
        for session in sessions where monitors[session.id] == nil {
            monitors[session.id] = Task { [weak self] in
                await self?.monitorSession(session.id, services: services)
            }
        }
    }

    private func suspendMonitoring() {
        monitors.values.forEach { $0.cancel() }
        monitors.removeAll()
        turnOutcomes.removeAll()
    }

    /// The monitored set is bounded: background sockets cost a server
    /// connection each, and recently active sessions cover the questions a
    /// user actually waits for.
    private func sessionsToMonitor(_ services: V2ClientServices) -> [V2SessionMeta] {
        services.dashboardRepository.sessions
            .filter { !$0.id.hasPrefix("local:") && !$0.archived }
            .sorted { ($0.sortAt ?? "") > ($1.sortAt ?? "") }
            .prefix(Self.maximumMonitoredSessions)
            .map { $0 }
    }

    private func monitorSession(_ sessionID: V2SessionID, services: V2ClientServices) async {
        var attempt = 0
        while !Task.isCancelled {
            do {
                // Session sockets replay nothing: subscription starts at the
                // live edge, so every received frame is a genuine change.
                let events = try await services.sessionDetail.updates(sessionId: sessionID, clientId: "ios-notifier-\(UUID().uuidString)")
                attempt = 0
                // Subscribing first closes the gap the seed read cannot: every
                // question that exists now, or arrives later, is covered once.
                let waiting = (try? await services.interactions.notices(sessionId: sessionID)) ?? []
                for notice in waiting { process(notice: notice, services: services) }
                for try await event in events {
                    guard !Task.isCancelled else { return }
                    receive(event, services: services)
                }
            } catch {
                if Task.isCancelled { return }
                if !V2ClientFailure(error).permitsAutomaticReconnect { return }
            }
            // An account switch while backoff-sleeping must not let the old
            // scope keep monitoring; suspendMonitoring() cancels this task.
            guard services === self.services else { return }
            do { try await Task.sleep(for: .seconds(min(1 << min(attempt, 4), 15))) } catch { return }
            attempt += 1
        }
    }

    private func receive(_ event: V2SessionEvent, services: V2ClientServices) {
        switch event.type {
        case "runtime.notice.updated":
            guard let raw = event.payload["notice"],
                  let data = try? JSONEncoder().encode(raw),
                  let notice = try? JSONDecoder().decode(V2RuntimeNotice.self, from: data) else { return }
            process(notice: notice, services: services)
        case "runtime.state.updated":
            guard let raw = event.payload["state"],
                  let data = try? JSONEncoder().encode(raw),
                  let state = try? JSONDecoder().decode(V2RuntimeState.self, from: data) else { return }
            process(state: state, services: services)
        default:
            break
        }
    }

    // MARK: - Trigger rules

    private func process(notice: V2RuntimeNotice, services: V2ClientServices) {
        // A monitor can still be draining when its scope is replaced; a stale
        // scope never raises notifications for the new account.
        guard isInBackground, services === self.services, notice.type == "interaction" else { return }
        if notice.status == .open {
            guard notifiedInteractionIDs.insert(notice.id).inserted else { return }
            deliverInteraction(notice, services: services)
        } else {
            // A retried or re-asked notice may reopen; allow a future prompt.
            notifiedInteractionIDs.remove(notice.id)
            if [.resolved, .closed, .expired, .cancelled, .failed].contains(notice.status) {
                UNUserNotificationCenter.current()
                    .removeDeliveredNotifications(withIdentifiers: ["interaction.\(notice.id)"])
            }
        }
    }

    private func process(state: V2RuntimeState, services: V2ClientServices) {
        guard services === self.services else { return }
        let (verdict, next) = SessionTurnOutcome.resolve(from: turnOutcomes[state.sessionId], status: state.status)
        turnOutcomes[state.sessionId] = next
        guard isInBackground, let verdict else { return }
        if verdict == .interrupted {
            deliverState(title: verdict.title,
                body: sessionTitle(state.sessionId, services: services), sessionID: state.sessionId)
        } else if state.status == .idle {
            deliverState(title: verdict.title,
                body: sessionTitle(state.sessionId, services: services), sessionID: state.sessionId)
        } else {
            // Error keeps its own wording; statusReason explains the failure.
            let reason = state.statusReason ?? state.error?.message
            deliverState(title: String(localized: "任务失败"),
                body: reason ?? sessionTitle(state.sessionId, services: services), sessionID: state.sessionId)
        }
    }

    private func sessionTitle(_ sessionID: V2SessionID, services: V2ClientServices) -> String {
        services.dashboardRepository.sessions.first { $0.id == sessionID }?.title
            ?? String(localized: "会话")
    }

    // MARK: - Delivery

    private func deliverInteraction(_ notice: V2RuntimeNotice, services: V2ClientServices) {
        guard isAuthorized else { return }
        let content = UNMutableNotificationContent()
        content.title = notice.title.isEmpty ? String(localized: "需要你的回答") : notice.title
        content.body = [notice.message, sessionTitle(notice.sessionId, services: services)]
            .compactMap { $0 }.first { !$0.isEmpty } ?? ""
        content.sound = .default
        content.threadIdentifier = notice.sessionId
        content.userInfo = [NotificationKeys.sessionIDUserInfo: notice.sessionId]
        deliver(content, identifier: "interaction.\(notice.id)")
    }

    private func deliverState(title: String, body: String, sessionID: V2SessionID) {
        guard isAuthorized else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.threadIdentifier = sessionID
        content.userInfo = [NotificationKeys.sessionIDUserInfo: sessionID]
        deliver(content, identifier: "turn.\(sessionID)")
    }

    private func deliver(_ content: UNMutableNotificationContent, identifier: String) {
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    private func refreshAuthorizationStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        isAuthorized = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
    }
}

extension SessionNotificationCoordinator: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard let sessionID = response.notification.request.content.userInfo[NotificationKeys.sessionIDUserInfo] as? String else { return }
        await open(sessionID: sessionID)
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // In-app interaction cards already present questions; no banners while foregrounded.
        completionHandler([])
    }

    /// Notification taps reuse the same selection the sidebar writes; the shell
    /// renders the session page from `AppState.chatSelection`.
    @MainActor private func open(sessionID: String) {
        onOpenSession?(sessionID)
    }
}
