import Foundation
import Observation

/// Port preview actions for every session of one account (preview 1.0).
///
/// A preview is created on demand, then each open exchanges a fresh one-time
/// ticket. When the instance has no port preview (404 or `preview_disabled`),
/// the card stays hidden for the rest of this app run.
@MainActor @Observable
final class PortPreviewStore {
    struct Key: Hashable {
        let sessionId: V2SessionID
        let port: Int
    }

    enum Phase: Equatable {
        case idle, opening
        case open(V3PreviewView)
        case stopping(V3PreviewView)

        var view: V3PreviewView? {
            switch self {
            case let .open(view), let .stopping(view): view
            case .idle, .opening: nil
            }
        }
    }

    /// What the card does next after a tap.
    enum Step: Equatable {
        case none
        /// Show the plaintext notice once, then call `confirmNotice`.
        case confirm(V3PreviewView)
        /// Open this ticket URL in the in-app browser.
        case present(URL)
    }

    private(set) var phases: [Key: Phase] = [:]
    private(set) var messages: [Key: String] = [:]
    private(set) var launching: Set<Key> = []
    private(set) var isDisabled = false
    @ObservationIgnored private var acknowledgedNotices: Set<String> = []
    @ObservationIgnored private let api: V3PreviewAPI

    init(api: V3PreviewAPI) { self.api = api }

    func phase(_ key: Key) -> Phase { phases[key] ?? .idle }

    /// Creates the preview if needed, then returns the next step for the card.
    func preview(_ key: Key, deviceId: String) async -> Step {
        guard let view = await ensureOpen(key, deviceId: deviceId) else { return .none }
        if view.plaintextNotice && !acknowledgedNotices.contains(view.previewId) { return .confirm(view) }
        return await launch(key, view: view)
    }

    /// The user read the plaintext notice for this preview.
    func confirmNotice(_ key: Key, view: V3PreviewView) async -> Step {
        acknowledgedNotices.insert(view.previewId)
        return await launch(key, view: view)
    }

    func stop(_ key: Key) async {
        guard case let .open(view) = phase(key) else { return }
        phases[key] = .stopping(view)
        messages[key] = nil
        do {
            try await api.close(previewId: view.previewId)
            phases[key] = .idle
        } catch let error as HTTPError where error.statusCode == 404 {
            phases[key] = .idle // Already gone.
        } catch {
            phases[key] = .open(view)
            messages[key] = PortPreviewErrorText.message(error)
        }
    }

    /// A port that stopped listening closes its preview on the Server; forget its
    /// local state so a port that returns starts a new preview.
    func retain(sessionId: V2SessionID, ports: Set<Int>) {
        for key in phases.keys where key.sessionId == sessionId && !ports.contains(key.port) {
            if case .stopping = phases[key] { continue }
            phases[key] = nil
        }
        for key in messages.keys where key.sessionId == sessionId && !ports.contains(key.port) { messages[key] = nil }
    }

    private func ensureOpen(_ key: Key, deviceId: String) async -> V3PreviewView? {
        guard !isDisabled else { return nil }
        switch phase(key) {
        case let .open(view) where !view.isClosed: return view
        case .opening, .stopping: return nil
        default: break
        }
        phases[key] = .opening
        messages[key] = nil
        do {
            let view = try await api.create(.init(deviceId: deviceId, port: key.port, sessionId: key.sessionId, visibility: .private))
            phases[key] = .open(view)
            return view
        } catch {
            phases[key] = .idle
            if PortPreviewErrorText.disablesPreview(error) {
                isDisabled = true
            } else {
                messages[key] = PortPreviewErrorText.message(error)
            }
            return nil
        }
    }

    private func launch(_ key: Key, view: V3PreviewView) async -> Step {
        guard !launching.contains(key) else { return .none }
        launching.insert(key)
        defer { launching.remove(key) }
        messages[key] = nil
        do {
            // Tickets are one-time and short-lived: request one for every open.
            let ticket = try await api.ticket(previewId: view.previewId)
            guard let url = URL(string: ticket.ticketUrl), ["https", "http"].contains(url.scheme?.lowercased() ?? "") else {
                throw HTTPError.invalidResponse
            }
            return .present(url)
        } catch {
            // The preview ended on the Server (port closed, expired); the next tap creates a new one.
            if (error as? HTTPError)?.statusCode == 404, case .open = phase(key) { phases[key] = .idle }
            messages[key] = PortPreviewErrorText.message(error)
            return .none
        }
    }
}
