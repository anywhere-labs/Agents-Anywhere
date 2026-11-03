import Foundation
import Observation

/// The model configuration page. The overview comes from dashboard pushes;
/// every action is a single request whose outcome arrives with the next push.
@MainActor @Observable
final class ModelConfigModel {
    enum TokensAction: Hashable { case link, sync, unlink }
    /// An action the Server refused as `busy`, kept to run again once the user
    /// agrees to interrupt the running tasks.
    enum InterruptRetry: Hashable {
        case rotate(V2ModelProfile, idempotencyKey: String)
        case restore(V2ModelAssignment)
    }

    private(set) var tokensBusy: TokensAction?
    private(set) var busyProfileID: String?
    private(set) var restoringID: String?
    private(set) var isCreatingProfile = false
    var feedback: ModelConfigFeedback?
    var pendingInterrupt: InterruptRetry?
    @ObservationIgnored private let api: V2ModelConfigAPI
    @ObservationIgnored private let dashboard: V2DashboardRepository
    @ObservationIgnored private let newKey: () -> String

    init(api: V2ModelConfigAPI, dashboard: V2DashboardRepository, newKey: @escaping () -> String = { UUID().uuidString }) {
        self.api = api; self.dashboard = dashboard; self.newKey = newKey
    }

    var overview: V2ModelConfigOverview? { dashboard.modelConfig }
    var connectors: [V2Connector] { dashboard.connectors }
    var canWrite: Bool { dashboard.canWrite }

    var rows: [ModelRuntimeRow] {
        let overview = overview
        return ModelConfigPresentation.configurableRuntimes(dashboard.runtimes).map { runtime in
            ModelRuntimeRow(runtime: runtime, assignment: overview?.assignment(for: runtime.target),
                deviceName: deviceName(runtime.connectorId))
        }
    }

    func deviceName(_ connectorID: String) -> String {
        dashboard.connectors.first { $0.id == connectorID }?.name ?? connectorID
    }

    func profileName(_ id: String) -> String { overview?.profile(id: id)?.name ?? id }

    func makeApplyModel(profile: V2ModelProfile) -> ModelApplyModel {
        ModelApplyModel(profile: profile, api: api, idempotencyKey: newKey(), deviceName: { [weak self] in self?.deviceName($0) ?? $0 })
    }

    /// Returns the one-time browser address that authorizes the link.
    func beginTokensLink() async -> URL? {
        var result: URL?
        await perform(.link) {
            let start = try await api.beginTokensLink()
            guard let url = URL(string: start.startUrl), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
                throw HTTPError.invalidResponse
            }
            result = url
        }
        return result
    }

    func syncTokens() async {
        await perform(.sync) {
            _ = try await api.syncTokens()
            feedback = .success(String(localized: "Models synced"))
        }
    }

    @discardableResult func unlinkTokens(allowInterrupt: Bool) async -> Bool {
        var finished = false
        await perform(.unlink) {
            let result = try await api.unlinkTokens(allowInterrupt: allowInterrupt)
            finished = true
            if result.unrestoredCount > 0 {
                feedback = .warning(String(localized: "Unlinked. \(result.unrestoredCount) runtimes could not be restored; restore them later."))
            } else if result.revoked {
                feedback = .success(String(localized: "Unlinked"))
            } else {
                feedback = .warning(String(localized: "Unlinked, but revoking failed. Revoke it under “Connected apps” in Tokens Anywhere."))
            }
        }
        return finished
    }

    func deleteProfile(_ profile: V2ModelProfile) async {
        await performProfile(profile.id) { try await api.deleteProfile(id: profile.id) }
    }

    /// The first attempt never interrupts; a `busy` answer comes before anything rotates.
    func rotateKey(_ profile: V2ModelProfile, allowInterrupt: Bool = false, idempotencyKey: String? = nil) async {
        let key = idempotencyKey ?? newKey()
        await performProfile(profile.id) {
            do {
                let operation = try await api.rotateTokensKey(profileId: profile.id, allowInterrupt: allowInterrupt, idempotencyKey: key)
                feedback = ModelConfigPresentation.operationMessage(operation)
            } catch let error as HTTPError where !allowInterrupt && error.serverCode == "busy" {
                pendingInterrupt = .rotate(profile, idempotencyKey: key)
            }
        }
    }

    func resumeInterrupted() async {
        guard let retry = pendingInterrupt else { return }
        pendingInterrupt = nil
        switch retry {
        case let .rotate(profile, key): await rotateKey(profile, allowInterrupt: true, idempotencyKey: key)
        case let .restore(assignment): await restore(assignment, allowInterrupt: true)
        }
    }

    /// Returns the error to show in the form, or nil once the profile is saved.
    func createProfile(_ draft: ModelProfileDraft) async -> String? {
        guard draft.isValid, !isCreatingProfile else { return String(localized: "That did not finish. Try again later.") }
        isCreatingProfile = true
        defer { isCreatingProfile = false }
        do {
            _ = try await api.createProfile(draft.request)
            feedback = .success(String(localized: "Profile saved"))
            return nil
        } catch {
            return ModelConfigErrorText.text(error)
        }
    }

    func restore(_ assignment: V2ModelAssignment, allowInterrupt: Bool = false) async {
        guard restoringID == nil else { return }
        restoringID = assignment.id
        defer { restoringID = nil }
        do {
            _ = try await api.restore(assignment.target, allowInterrupt: allowInterrupt)
            feedback = .success(String(localized: "Previous configuration restored"))
        } catch let error as HTTPError where !allowInterrupt && error.serverCode == "busy" {
            pendingInterrupt = .restore(assignment)
        } catch { feedback = .error(ModelConfigErrorText.text(error)) }
    }

    private func perform(_ action: TokensAction, _ body: () async throws -> Void) async {
        guard tokensBusy == nil else { return }
        tokensBusy = action
        defer { tokensBusy = nil }
        do { try await body() } catch { feedback = .error(ModelConfigErrorText.text(error)) }
    }

    private func performProfile(_ id: String, _ body: () async throws -> Void) async {
        guard busyProfileID == nil else { return }
        busyProfileID = id
        defer { busyProfileID = nil }
        do { try await body() } catch { feedback = .error(ModelConfigErrorText.text(error)) }
    }
}

nonisolated struct ModelRuntimeRow: Identifiable, Hashable {
    let runtime: V2DeviceRuntime
    let assignment: V2ModelAssignment?
    let deviceName: String

    var id: String { runtime.target.key }
    var status: V2ModelConnectionStatus? { ModelConfigPresentation.connectionStatus(runtime: runtime, assignment: assignment) }
    var isManagedInstance: Bool { runtime.managedBy == "model-config" }
}

/// One apply sheet: a preview, the user's choices, and one idempotency key so a
/// retried submit cannot write the connection twice.
@MainActor @Observable
final class ModelApplyModel {
    let profile: V2ModelProfile
    private(set) var targets: [V2ModelPreviewTarget]?
    var selected: Set<String> = []
    var allowInterrupt = false
    var confirmNativeGlobal = false
    private(set) var isApplying = false
    private(set) var loadError: String?
    private(set) var applyError: String?
    @ObservationIgnored let idempotencyKey: String
    @ObservationIgnored private let api: V2ModelConfigAPI
    @ObservationIgnored let deviceName: (String) -> String

    init(profile: V2ModelProfile, api: V2ModelConfigAPI, idempotencyKey: String, deviceName: @escaping (String) -> String) {
        self.profile = profile; self.api = api; self.idempotencyKey = idempotencyKey; self.deviceName = deviceName
    }

    var chosen: [V2ModelPreviewTarget] { (targets ?? []).filter { selected.contains($0.id) && $0.canApply } }
    var needsNativeGlobal: Bool { chosen.contains { $0.requiresConfirmation } }
    var interruptedSessions: Int { chosen.reduce(0) { $0 + $1.interruptedSessions } }
    var canApply: Bool { !isApplying && !chosen.isEmpty && (!needsNativeGlobal || confirmNativeGlobal) }

    func load() async {
        guard targets == nil else { return }
        do {
            let preview = try await api.preview(profileId: profile.id)
            targets = preview.targets
            selected = ModelConfigPresentation.initialSelection(preview.targets)
            loadError = nil
        } catch { loadError = ModelConfigErrorText.text(error) }
    }

    func toggle(_ target: V2ModelPreviewTarget, _ on: Bool) {
        guard target.canApply else { return }
        if on { selected.insert(target.id) } else { selected.remove(target.id) }
    }

    /// Returns the operation once the Server has answered.
    func apply() async -> V2ModelOperation? {
        guard canApply else { return nil }
        isApplying = true; applyError = nil
        defer { isApplying = false }
        do {
            return try await api.apply(.init(profileId: profile.id, targets: chosen.map(\.target),
                allowInterrupt: interruptedSessions > 0 && allowInterrupt,
                confirmNativeGlobal: needsNativeGlobal && confirmNativeGlobal), idempotencyKey: idempotencyKey)
        } catch {
            applyError = ModelConfigErrorText.text(error)
            return nil
        }
    }
}
