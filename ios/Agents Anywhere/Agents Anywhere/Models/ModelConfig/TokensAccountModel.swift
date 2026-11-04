import Foundation
import Observation

nonisolated enum TokensAccountTab: Hashable, CaseIterable {
    case account, models, runtimes
}

/// The linked Tokens Anywhere account page: who it is, its balance, which of
/// its models runtimes get and under which names, and what it has spent.
/// Account and usage are read on request; the models' saved choices come
/// with the dashboard push, and a save's outcome arrives with the next one.
@MainActor @Observable
final class TokensAccountModel {
    /// The account, balance and console pages; nil until the first answer.
    private(set) var info: V2TokensAccountInfo?
    private(set) var infoFailed = false
    /// The open tab; nil until the page first shows, then it picks one.
    var tab: TokensAccountTab?
    /// The account the page last loaded, so coming back to it keeps unsaved edits.
    var loadedKey: String?

    // MARK: Models

    /// Tokens models from the active profile, each once.
    private(set) var models: [TokensModel] = []
    private(set) var groups: [TokensVendorGroup] = []
    /// What the Server last said is saved, or what this page last saved.
    private(set) var saved: V2ModelPreferences = .empty
    var draft: V2ModelPreferences = .empty
    private(set) var isSaving = false
    /// Groups the user opened or closed; nil keeps the default.
    var openGroups: Set<String>?

    // MARK: Usage

    var usageDays = 7
    var usageModel: String?
    private(set) var usage: V2TokensUsage?
    private(set) var usageFailed = false
    private(set) var usageLoading = false

    @ObservationIgnored private let api: V2ModelConfigAPI
    @ObservationIgnored private var pushed: V2ModelPreferences?
    @ObservationIgnored private var infoRequest = 0
    @ObservationIgnored private var usageRequest = 0
    @ObservationIgnored var report: (ModelConfigFeedback) -> Void = { _ in }

    init(api: V2ModelConfigAPI) { self.api = api }

    /// Takes the active Tokens profile from a push. New saved choices replace
    /// the draft; the same ones keep what the user is editing.
    func reconcile(profile: V2ModelProfile?) {
        let next = profile.map(TokensAccountPresentation.models) ?? []
        if next != models {
            models = next
            groups = TokensAccountPresentation.vendorGroups(next)
        }
        let incoming = profile?.preferences ?? .empty
        guard incoming != pushed else { return }
        pushed = incoming
        saved = incoming
        draft = incoming
    }

    /// Forgets the account, as after unlinking.
    func reset() {
        models = []; groups = []; saved = .empty; draft = .empty; pushed = nil; usageLoading = false
        info = nil; infoFailed = false; tab = nil; usage = nil; usageFailed = false; usageModel = nil
        openGroups = nil; loadedKey = nil
        infoRequest += 1; usageRequest += 1
    }

    func loadInfo() async {
        infoRequest += 1
        let request = infoRequest
        infoFailed = false
        do {
            let value = try await api.tokensAccount()
            guard request == infoRequest, !Task.isCancelled else { return }
            info = value
        } catch {
            guard request == infoRequest, !Task.isCancelled else { return }
            infoFailed = true
        }
    }

    /// Reads usage for the chosen days; a later choice wins over a slower answer.
    func loadUsage() async {
        usageRequest += 1
        let request = usageRequest
        usageLoading = true
        defer { if request == usageRequest { usageLoading = false } }
        usageFailed = false
        usage = nil
        do {
            let value = try await api.tokensUsage(days: usageDays)
            guard request == usageRequest, !Task.isCancelled else { return }
            usage = value
            if let selected = usageModel, !TokensAccountPresentation.usageModelIDs(value).contains(selected) { usageModel = nil }
        } catch {
            guard request == usageRequest, !Task.isCancelled else { return }
            usageFailed = true
        }
    }

    var usageSummary: TokensUsageSummary? {
        usage.map { TokensAccountPresentation.summarizeUsage($0, model: usageModel) }
    }

    /// The models the filter offers, and the chosen one even if the report no longer names it.
    var usageModelIDs: [String] {
        var ids = usage.map(TokensAccountPresentation.usageModelIDs) ?? []
        if let usageModel, !ids.contains(usageModel) { ids.append(usageModel) }
        return ids
    }

    // MARK: Model choices

    func isEnabled(_ id: String) -> Bool { !draft.disabled.contains(id) }

    var enabledCount: Int { models.filter { isEnabled($0.id) }.count }

    /// The draft as it would be saved.
    var next: V2ModelPreferences { TokensAccountPresentation.cleanPreferences(draft, models: models) }

    var changes: Int {
        TokensAccountPresentation.changeCount(TokensAccountPresentation.cleanPreferences(saved, models: models), next)
    }

    var isDefault: Bool {
        TokensAccountPresentation.samePreferences(TokensAccountPresentation.cleanPreferences(saved, models: models), .empty)
    }

    /// Groups start open while the list is short.
    var expandedGroups: Set<String> {
        openGroups ?? (models.count <= 12 ? Set(groups.map(\.key)) : [])
    }

    func setGroup(_ key: String, open: Bool) {
        var set = expandedGroups
        if open { set.insert(key) } else { set.remove(key) }
        openGroups = set
    }

    func setEnabled(_ ids: [String], _ on: Bool) {
        var off = draft.disabled
        for id in ids {
            if on { off.removeAll { $0 == id } }
            else if !off.contains(id) { off.append(id) }
        }
        draft.disabled = off
    }

    /// An empty name, or the model's own, goes back to the original.
    func rename(_ model: TokensModel, to value: String) {
        let name = String(value.trimmingCharacters(in: .whitespacesAndNewlines).prefix(128))
        if name.isEmpty || name == model.originalName { draft.names.removeValue(forKey: model.id) }
        else { draft.names[model.id] = name }
    }

    func discard() { draft = saved }

    /// Saves the draft, or the defaults. Runtimes using Anywhere switch to the
    /// new models in the background; their progress is in the channel state.
    func save(_ preferences: V2ModelPreferences) async {
        guard !isSaving else { return }
        if !models.isEmpty && !models.contains(where: { !preferences.disabled.contains($0.id) }) {
            report(.error(String(localized: "Keep at least one model.")))
            return
        }
        isSaving = true
        defer { isSaving = false }
        do {
            let result = try await api.saveTokensModels(preferences)
            saved = preferences
            draft = preferences
            report(.success(result.applying
                ? String(localized: "Saved. Applying to the runtimes using Tokens Anywhere.")
                : String(localized: "pages.settings.modelConfigs.account.savedNoRuntimes")))
        } catch {
            report(.error(ModelConfigErrorText.text(error)))
        }
    }

    func saveDraft() async { await save(next) }

    func restoreDefaults() async { await save(.empty) }
}
