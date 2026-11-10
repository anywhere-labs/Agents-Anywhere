import SwiftUI

/// One channel's page, as on the desktop: whether it is applied, what it is,
/// and the runtimes that should use it. Alerts live here, where they show.
struct ChannelDetailView: View {
    let model: ModelConfigModel
    let channelId: String
    let linker: TokensLinkCoordinator
    @State private var confirmingOverride: PendingChannelOverride?
    @State private var deleting: V2ModelProfile?
    @State private var confirmingExit = false
    @State private var rotating: V2ModelProfile?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    private var isTokens: Bool { channelId == V2ModelChannel.tokens }
    private var profile: V2ModelProfile? { model.overview?.profiles.first { $0.id == channelId } }

    /// Deleted elsewhere while open: there is nothing left to show.
    private var exists: Bool {
        guard let overview = model.overview else { return true }
        switch channelId {
        case V2ModelChannel.native: return true
        case V2ModelChannel.tokens: return overview.tokens?.available == true
        default: return profile != nil
        }
    }

    var body: some View {
        List {
            ModelConfigFeedbackSection(model: model)
            if let overview = model.overview {
                if !overview.secretConfigured { SecretMissingSection() }
                content(overview)
            }
        }
        .settingsPage(model.channelLabel(channelId))
        .onChange(of: exists) { _, exists in if !exists { dismiss() } }
        .modifier(TokensAccountLifecycle(model: model, linker: linker, active: isTokens, scenePhase: scenePhase))
        .alert(String(localized: "pages.settings.modelConfigs.signOutTitle"), isPresented: $confirmingExit) {
            Button(String(localized: "Cancel"), role: .cancel) {}
            Button(String(localized: "pages.settings.modelConfigs.signOut"), role: .destructive) { model.startExit() }
        } message: {
            let applied = model.channel?.channel
            let fallback = applied.flatMap { $0 == V2ModelChannel.tokens ? nil : $0 } ?? V2ModelChannel.native
            Text(String(localized: "Runtimes on Tokens Anywhere restart and switch to \(model.channelLabel(fallback)); those running tasks switch once the tasks finish. When all have switched, the account is signed out and this instance's access is revoked."))
        }
        .alert(String(localized: "Delete profile"), isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button(String(localized: "Cancel"), role: .cancel) { deleting = nil }
            Button(String(localized: "Delete profile"), role: .destructive) {
                guard let profile = deleting else { return }
                deleting = nil
                Task { await model.deleteProfile(profile) }
            }
        } message: { Text(deleting?.name ?? "") }
        .alert(String(localized: "Rotate key"), isPresented: Binding(get: { rotating != nil }, set: { if !$0 { rotating = nil } })) {
            Button(String(localized: "Cancel"), role: .cancel) { rotating = nil }
            Button(String(localized: "Rotate key"), role: .destructive) {
                guard let profile = rotating else { return }
                rotating = nil
                Task { await model.rotateKey(profile) }
            }
        } message: {
            Text(String(localized: "pages.settings.modelConfigs.rotateDescription"))
        }
        .alert(String(localized: "pages.settings.modelConfigs.interruptTitle"), isPresented: Binding(
            get: { model.pendingInterrupt != nil }, set: { if !$0 { model.pendingInterrupt = nil } }
        )) {
            Button(String(localized: "Cancel"), role: .cancel) { model.pendingInterrupt = nil }
            Button(String(localized: "pages.settings.modelConfigs.interruptContinue"), role: .destructive) {
                Task { await model.resumeInterrupted() }
            }
        } message: {
            Text(String(localized: "pages.settings.modelConfigs.interruptDescription"))
        }
        .alert(String(localized: "pages.settings.modelConfigs.details.nativeGlobalTitle"), isPresented: Binding(
            get: { confirmingOverride != nil }, set: { if !$0 { confirmingOverride = nil } }
        ), presenting: confirmingOverride) { pending in
            Button(String(localized: "Cancel"), role: .cancel) { confirmingOverride = nil }
            Button(String(localized: "pages.settings.modelConfigs.details.nativeGlobalConfirm")) {
                confirmingOverride = nil
                Task { await model.setRuntimeChannel(pending.row, channel: pending.channel, confirmNativeGlobal: true) }
            }
        } message: { pending in
            Text(String(localized: "\(pending.row.runtimeName) has no separate instance managed by AA. Using \(model.channelLabel(pending.channel ?? V2ModelChannel.native)) rewrites its own global settings, which also affects anything using it outside AA."))
        }
    }

    @ViewBuilder private func content(_ overview: V2ModelConfigOverview) -> some View {
        switch channelId {
        case V2ModelChannel.native:
            applySection(String(localized: "pages.settings.modelConfigs.native.description"))
            if !model.channelRows(channelId).isEmpty { runtimes(showsTitle: true) }
        case V2ModelChannel.tokens:
            if let tokens = overview.tokens {
                TokensChannelDetail(model: model, tokens: tokens, linker: linker,
                    onExit: { confirmingExit = true }, onRotate: { rotating = $0 }) {
                    applyRows(available: overview.activeTokensProfile != nil && !model.exitBusy)
                } runtimes: { showsTitle in
                    runtimes(showsTitle: showsTitle)
                }
            }
        default:
            if let profile {
                if profile.source == "manual" && profile.isActive {
                    applySection(String(localized: "A model service's address, key and models."))
                }
                Section {
                    if !profile.isActive {
                        ModelStatusBadge(title: String(localized: "pages.settings.modelConfigs.channels.detached"), tone: .warning)
                    }
                    ModelProfileDetails(profile: profile, usedBy: model.runtimeCount(using: profile.id), expanded: true)
                }
                if !model.channelRows(channelId).isEmpty { runtimes(showsTitle: true) }
                let inUse = model.isInUse(profile)
                Section {
                    Button(role: .destructive) {
                        deleting = profile
                    } label: {
                        Label(String(localized: "Delete profile"), appSymbol: "trash")
                    }
                    .disabled(inUse || model.busyProfileID != nil || !model.canWrite)
                } footer: {
                    if inUse { Text(String(localized: "pages.settings.modelConfigs.deleteInUse")) }
                }
            }
        }
    }

    private func applySection(_ about: String) -> some View {
        Section {
            applyRows(available: true)
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                Text(about)
                if model.channel.map({ $0.channel != channelId }) == true {
                    Text(String(localized: "pages.settings.modelConfigs.current.description"))
                }
            }
        }
    }

    /// 「已应用」, or the one button that applies this channel.
    @ViewBuilder private func applyRows(available: Bool) -> some View {
        if let state = model.channel {
            if state.channel == channelId {
                Label {
                    Text(String(localized: "pages.settings.modelConfigs.current.inUse"))
                } icon: {
                    AppSymbol("checkmark.circle", size: 16).foregroundStyle(.green)
                }
            } else {
                Button {
                    Task { await model.setChannel(channelId) }
                } label: {
                    HStack(spacing: 8) {
                        if model.channelBusyKey == ModelConfigModel.globalChannelKey { ProgressView().controlSize(.small) }
                        Text(String(localized: "pages.settings.modelConfigs.current.makeCurrent"))
                    }
                }
                .disabled(!available || model.channelBusyKey != nil || !model.canWrite || model.overview?.secretConfigured != true)
            }
        }
    }

    private func runtimes(showsTitle: Bool) -> some View {
        ChannelRuntimeSections(model: model, channelId: channelId, showsTitle: showsTitle, confirmingOverride: $confirmingOverride)
    }
}

/// The linked account page's reads and its pinned bar; does nothing on other channels.
private struct TokensAccountLifecycle: ViewModifier {
    let model: ModelConfigModel
    let linker: TokensLinkCoordinator
    let active: Bool
    let scenePhase: ScenePhase

    /// The linked account's page is showing.
    private var showsAccount: Bool {
        active && model.overview?.tokens?.available == true && model.overview?.tokens?.link?.isLinked == true
            && model.exitedLink != model.tokens?.link
    }

    /// Changes when another account's page shows; nil while none does.
    private var accountKey: String? {
        guard showsAccount, let link = model.overview?.tokens?.link else { return nil }
        return "\(link.account.id)#\(link.linkedAt ?? "")"
    }

    /// Changes when the account tab, with its usage, opens or its period changes.
    private var usageKey: String? {
        guard let account = accountKey, model.account.tab == .account else { return nil }
        return "\(account)#\(model.account.usageDays)"
    }

    func body(content: Content) -> some View {
        content
            // The browser sheet covers this page; the next snapshot that shows the link closes it.
            .onChange(of: model.overview?.tokens?.link) { _, link in if active { linker.observe(link) } }
            // A push with new saved model choices replaces what the page started from.
            .onChange(of: model.overview?.activeTokensProfile, initial: true) { _, profile in
                if active { model.account.reconcile(profile: profile) }
            }
            .task(id: accountKey) {
                guard let accountKey else { return }
                if accountKey != model.account.loadedKey {
                    model.account.reset()
                    model.account.loadedKey = accountKey
                    model.account.reconcile(profile: model.overview?.activeTokensProfile)
                }
                if model.account.tab == nil { model.account.tab = .account }
                await model.account.loadInfo()
            }
            // Back from topping up in the browser, the balance should already show it.
            .onChange(of: scenePhase) { _, phase in
                if phase == .active && showsAccount { Task { await model.account.loadInfo() } }
            }
            .task(id: usageKey) {
                if usageKey != nil { await model.account.loadUsage() }
            }
            .safeAreaInset(edge: .bottom) {
                if showsAccount && model.account.tab == .models && model.account.changes > 0 {
                    TokensPendingBar(model: model)
                }
            }
    }
}
