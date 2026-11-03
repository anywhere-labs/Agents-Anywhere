import Foundation
import Observation

/// The model configuration page. The overview comes from dashboard pushes;
/// every action is a single request. Channel writes answer with the channel
/// state, which the page shows until the next push replaces it.
@MainActor @Observable
final class ModelConfigModel {
    enum TokensAction: Hashable { case link, sync }
    /// A rotation the Server refused as `busy`, kept to run again once the
    /// user agrees to interrupt the running tasks.
    enum InterruptRetry: Hashable {
        case rotate(V2ModelProfile)
    }

    private(set) var tokensBusy: TokensAction?
    private(set) var busyProfileID: String?
    private(set) var isCreatingProfile = false
    /// The channel write in flight: `ModelConfigModel.globalChannelKey` or a runtime's target key.
    private(set) var channelBusyKey: String?
    var feedback: ModelConfigFeedback?
    var pendingInterrupt: InterruptRetry?
    /// The linked Tokens Anywhere account page.
    let account: TokensAccountModel
    /// A write's answer and the push it answered on top of; a newer push wins.
    private var answered: AnsweredChannel?
    @ObservationIgnored private let api: V2ModelConfigAPI
    @ObservationIgnored private let dashboard: V2DashboardRepository

    static let globalChannelKey = "*"

    private struct AnsweredChannel {
        let state: V2ModelChannelState
        let base: V2ModelChannelState?
    }

    init(api: V2ModelConfigAPI, dashboard: V2DashboardRepository) {
        self.api = api; self.dashboard = dashboard
        account = TokensAccountModel(api: api)
        account.report = { [weak self] in self?.feedback = $0 }
    }

    var overview: V2ModelConfigOverview? { dashboard.modelConfig }
    var connectors: [V2Connector] { dashboard.connectors }
    var canWrite: Bool { dashboard.canWrite }
    var tokens: V2TokensLinkStatus? { overview?.tokens }

    func deviceName(_ connectorID: String) -> String {
        dashboard.connectors.first { $0.id == connectorID }?.name ?? connectorID
    }

    func profileName(_ id: String) -> String { overview?.profile(id: id)?.name ?? id }

    // MARK: Current channel

    /// The latest channel state: a write's answer until a push replaces it.
    var channel: V2ModelChannelState? {
        let pushed = overview?.channel
        if let answered, answered.base == pushed { return answered.state }
        return pushed
    }

    var channelOptions: [ModelChannelOption] {
        guard let overview else { return [] }
        return ChannelPresentation.options(overview: overview, current: channel?.channel)
    }

    var channelSummary: ChannelSummary? { channel.map(ChannelPresentation.summary) }

    var channelGroups: (devices: [ChannelDeviceGroup], unsupported: [ChannelRuntimeRow]) {
        guard let channel else { return ([], []) }
        return ChannelPresentation.groups(channel, runtimes: dashboard.runtimes, connectors: dashboard.connectors)
    }

    /// Runtimes that want or use the Anywhere channel, for the account page.
    var tokensRuntimes: [ChannelRuntimeRow] {
        channelGroups.devices.flatMap(\.rows).filter {
            $0.entry.desired == V2ModelChannel.tokens || $0.entry.actual == V2ModelChannel.tokens
        }
    }

    /// A runtime is still switching to or from Anywhere.
    var tokensSwitching: Bool { tokensRuntimes.contains { ChannelPresentation.isInProgress($0.entry.state) } }

    /// Current, chosen for a runtime, or in use; such a profile cannot be deleted.
    func isInUse(_ profile: V2ModelProfile) -> Bool {
        (overview?.usage(of: profile.id) ?? 0) > 0
            || channel?.uses(profile.isTokens ? V2ModelChannel.tokens : profile.id) == true
    }

    /// Runtimes actually on `channel`; the assignments until a channel state arrives.
    func runtimeCount(using channel: String) -> Int {
        if let state = self.channel { return state.runtimes.filter { $0.actual == channel }.count }
        guard let overview else { return 0 }
        let profileID = channel == V2ModelChannel.tokens ? overview.activeTokensProfile?.id : channel
        return profileID.map(overview.usage(of:)) ?? 0
    }

    func channelLabel(_ channel: String) -> String {
        ChannelPresentation.label(channel, profiles: overview?.profiles ?? [])
    }

    func isCurrentChannel(_ channel: String) -> Bool { self.channel?.channel == channel }

    /// Asks for the state; reading it also lets the Server resume waiting switches.
    func refreshChannel() async {
        guard canWrite, let state = try? await api.channel() else { return }
        adopt(state)
    }

    func setChannel(_ channel: String) async {
        guard channel != self.channel?.channel else { return }
        await performChannel(Self.globalChannelKey) { try await api.setChannel(channel) }
    }

    /// nil follows the current channel again.
    func setRuntimeChannel(_ row: ChannelRuntimeRow, channel: String?, confirmNativeGlobal: Bool = false) async {
        await performChannel(row.id) {
            try await api.setRuntimeChannel(row.target, channel: channel,
                confirmNativeGlobal: confirmNativeGlobal && row.needsGlobalConfirmation(for: channel))
        }
    }

    /// Retries one runtime, or every restored and failed one.
    func retryChannel(_ row: ChannelRuntimeRow? = nil) async {
        await performChannel(row?.id ?? Self.globalChannelKey) { try await api.retryChannel(row?.target) }
    }

    /// Keeps a write's answer until a push replaces it, unless a newer push already did.
    func adopt(_ state: V2ModelChannelState) {
        let pushed = overview?.channel
        if let pushed, pushed.revision > state.revision { return }
        if let answered, answered.state.revision > state.revision { return }
        answered = AnsweredChannel(state: state, base: pushed)
    }

    private func performChannel(_ key: String, _ body: () async throws -> V2ModelChannelState) async {
        guard channelBusyKey == nil else { return }
        channelBusyKey = key
        defer { channelBusyKey = nil }
        do { adopt(try await body()) } catch { feedback = .error(ModelConfigErrorText.text(error)) }
    }

    // MARK: Profiles and Tokens Anywhere

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

    func deleteProfile(_ profile: V2ModelProfile) async {
        await performProfile(profile.id) { try await api.deleteProfile(id: profile.id) }
    }

    /// The first attempt never interrupts; a `busy` answer comes before anything rotates.
    func rotateKey(_ profile: V2ModelProfile, allowInterrupt: Bool = false) async {
        await performProfile(profile.id) {
            do {
                adopt(try await api.rotateTokensKey(profileId: profile.id, allowInterrupt: allowInterrupt))
                feedback = .success(String(localized: "Key rotated. Runtimes using Anywhere get the new key."))
            } catch let error as HTTPError where !allowInterrupt && error.serverCode == "busy" {
                pendingInterrupt = .rotate(profile)
            }
        }
    }

    func resumeInterrupted() async {
        guard let retry = pendingInterrupt else { return }
        pendingInterrupt = nil
        switch retry {
        case let .rotate(profile): await rotateKey(profile, allowInterrupt: true)
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
