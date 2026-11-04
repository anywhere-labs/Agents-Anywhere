import SwiftUI

/// 「配置管理」: the current channel and each runtime's switch, model profiles,
/// and the Tokens Anywhere link. Everything renders from the channel state and
/// runtime capabilities, never runtime names.
struct ModelConfigSettingsView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        Group {
            if let services = appState.nativeChatServices {
                ModelConfigPage(services: services)
            } else {
                List {
                    ContentUnavailableView(String(localized: "Model configuration"), appSymbol: "slider.horizontal.3")
                }
            }
        }
        .settingsPage(String(localized: "Model configuration"))
    }
}

private struct ModelConfigPage: View {
    @StateObject private var storage: StableViewModel<ModelConfigModel>
    @State private var linker = TokensLinkCoordinator()
    @State private var creating = false
    @State private var confirmingOverride: PendingChannelOverride?
    @State private var deleting: V2ModelProfile?
    @State private var rotating: V2ModelProfile?
    @Environment(\.scenePhase) private var scenePhase

    init(services: V2ClientServices) {
        _storage = StateObject(wrappedValue: StableViewModel {
            ModelConfigModel(api: services.modelConfigAPI, dashboard: services.dashboardRepository)
        })
    }

    private var model: ModelConfigModel { storage.value }

    var body: some View {
        List {
            if let feedback = model.feedback { feedbackSection(feedback) }
            if let overview = model.overview {
                if !overview.secretConfigured {
                    Section {
                        Label(String(localized: "The server has no AGENT_SERVER_SECRET (at least 32 characters) yet. Ask an administrator to set it before saving keys or linking Tokens Anywhere."),
                            appSymbol: "exclamationmark.triangle")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if let channel = model.channel {
                    CurrentChannelSections(model: model, state: channel,
                        confirmingOverride: $confirmingOverride)
                }
                if let tokens = overview.tokens, tokens.available {
                    TokensChannelSection(model: model, tokens: tokens, linker: linker)
                }
                profilesSection(overview)
            } else {
                Section {
                    HStack { Spacer(); ProgressView(); Spacer() }.padding(.vertical, 24)
                }
            }
        }
        // The browser sheet covers this page, so leaving it open is not a reason
        // to cancel; the next snapshot that shows the link closes it.
        .onChange(of: model.overview?.tokens?.link) { _, link in linker.observe(link) }
        // Reading the state also lets the Server resume switches waiting for this moment.
        .task { await model.refreshChannel() }
        .safeAreaInset(edge: .bottom) {
            if showsAccount && model.account.tab == .models && model.account.changes > 0 {
                TokensPendingBar(model: model)
            }
        }
        // A push with new saved model choices replaces what the page started from.
        .onChange(of: model.overview?.activeTokensProfile, initial: true) { _, profile in
            model.account.reconcile(profile: profile)
        }
        .onChange(of: showsAccount, initial: true) { _, shows in
            if !shows { model.account.tab = nil }
            else if model.account.tab == nil { model.account.tab = .models }
        }
        // Back from topping up in the browser, the balance should already show it.
        .task(id: accountKey) {
            if accountKey != nil { await model.account.loadInfo() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active && showsAccount { Task { await model.account.loadInfo() } }
        }
        .task(id: usageKey) {
            if usageKey != nil { await model.account.loadUsage() }
        }
        .sheet(isPresented: $creating) { ModelProfileEditorSheet(model: model) }
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
            Text(String(localized: "Creates a new key in Tokens Anywhere and writes it to every runtime that uses it; the old key stops working at once."))
        }
        .alert(String(localized: "Tasks are running"), isPresented: Binding(
            get: { model.pendingInterrupt != nil }, set: { if !$0 { model.pendingInterrupt = nil } }
        )) {
            Button(String(localized: "Cancel"), role: .cancel) { model.pendingInterrupt = nil }
            Button(String(localized: "Interrupt and continue"), role: .destructive) {
                Task { await model.resumeInterrupted() }
            }
        } message: {
            Text(String(localized: "Continuing restarts the affected runtimes and interrupts their running tasks."))
        }
        .alert(String(localized: "Change its own global settings?"), isPresented: Binding(
            get: { confirmingOverride != nil }, set: { if !$0 { confirmingOverride = nil } }
        ), presenting: confirmingOverride) { pending in
            Button(String(localized: "Cancel"), role: .cancel) { confirmingOverride = nil }
            Button(String(localized: "Confirm and switch")) {
                confirmingOverride = nil
                Task { await model.setRuntimeChannel(pending.row, channel: pending.channel, confirmNativeGlobal: true) }
            }
        } message: { pending in
            Text(String(localized: "\(pending.row.runtimeName) keeps its model connection in its own global settings, so this also affects using it outside AA."))
        }
    }

    /// The linked account's page is showing.
    private var showsAccount: Bool {
        model.overview?.tokens?.available == true && model.overview?.tokens?.link?.isLinked == true
    }

    /// Changes when another account's page shows; nil while none does.
    private var accountKey: String? {
        guard showsAccount, let link = model.overview?.tokens?.link else { return nil }
        return "\(link.account.id)#\(link.linkedAt ?? "")"
    }

    /// Changes when the usage tab opens or its period changes; nil while it is closed.
    private var usageKey: String? {
        guard let account = accountKey, model.account.tab == .usage else { return nil }
        return "\(account)#\(model.account.usageDays)"
    }


    // MARK: Feedback

    private func feedbackSection(_ feedback: ModelConfigFeedback) -> some View {
        Section {
            HStack(alignment: .top, spacing: 10) {
                switch feedback {
                case .success: AppSymbol("checkmark.circle", size: 16).foregroundStyle(.green)
                case .warning: AppSymbol("exclamationmark.triangle", size: 16).foregroundStyle(.orange)
                case .error: AppSymbol("exclamationmark.circle", size: 16).foregroundStyle(.red)
                }
                Text(feedback.message).font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
                Button { model.feedback = nil } label: { AppSymbol("xmark", size: 14).foregroundStyle(.secondary) }
                    .buttonStyle(.plain).accessibilityLabel(String(localized: "Close"))
            }
        }
        .task(id: feedback) {
            do { try await Task.sleep(for: .seconds(6)) } catch { return }
            if model.feedback == feedback { model.feedback = nil }
        }
    }

    // MARK: Profiles

    private func profilesSection(_ overview: V2ModelConfigOverview) -> some View {
        Section {
            if overview.profiles.isEmpty {
                Text(String(localized: "No model profiles yet.")).font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(overview.profiles) { profile in profileRow(profile) }
            Button {
                creating = true
            } label: {
                Label(String(localized: "Add profile"), appSymbol: "plus")
            }
            .disabled(!overview.secretConfigured || !model.canWrite)
        } header: {
            Text(String(localized: "Model profiles"))
        } footer: {
            Text(String(localized: "A model service's address, key and models."))
        }
    }

    private func profileRow(_ profile: V2ModelProfile) -> some View {
        let busy = model.busyProfileID == profile.id
        let canDelete = profile.source == "manual" || !profile.isActive
        let channel = profile.isTokens ? V2ModelChannel.tokens : profile.id
        let current = model.isCurrentChannel(channel)
        let canBeCurrent = !current && profile.isActive && model.channelOptions.contains { $0.id == channel }
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(profile.name).font(.body.weight(.semibold))
                    // The Tokens profile is already named after its source.
                    let source = ModelConfigPresentation.sourceLabel(profile.source)
                    if source != profile.name { ModelStatusBadge(title: source, tone: .neutral) }
                    if current { ModelStatusBadge(title: String(localized: "In use"), tone: .ok) }
                    if !profile.isActive { ModelStatusBadge(title: String(localized: "Unlinked"), tone: .warning) }
                }
                ModelProfileDetails(profile: profile, usedBy: model.runtimeCount(using: channel))
            }
            Spacer(minLength: 0)
            if busy { ProgressView() }
            Menu {
                if canBeCurrent {
                    Button(String(localized: "Set as current channel"), systemImage: "checkmark.circle") {
                        Task { await model.setChannel(channel) }
                    }
                    .disabled(model.channelBusyKey != nil || !model.canWrite)
                }
                if profile.isTokens && profile.isActive {
                    Button(String(localized: "Rotate key"), systemImage: "key") { rotating = profile }
                        .disabled(!model.canWrite)
                }
                if canDelete {
                    Divider()
                    Button(String(localized: "Delete profile"), systemImage: "trash", role: .destructive) { deleting = profile }
                        .disabled(model.isInUse(profile) || !model.canWrite)
                }
            } label: {
                AppSymbol("ellipsis", size: 18).foregroundStyle(.secondary)
                    .frame(width: 36, height: 44).contentShape(.rect)
            }
            .buttonStyle(.plain).disabled(model.busyProfileID != nil)
            .accessibilityLabel(Text(profile.name))
        }
        .swipeActions(edge: .trailing) {
            if canBeCurrent && model.canWrite && model.channelBusyKey == nil {
                Button(String(localized: "Set as current channel")) {
                    Task { await model.setChannel(channel) }
                }
                .tint(.accentColor)
            }
        }
    }
}

// MARK: - Add profile

private struct ModelProfileEditorSheet: View {
    let model: ModelConfigModel
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ModelProfileDraft()
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(String(localized: "Name"), text: $draft.name)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                } header: {
                    Text(String(localized: "Name"))
                } footer: {
                    Text(String(localized: "Enter the model service's address and key. Saving detects the protocols and models it supports."))
                }
                // Once detection fails, each protocol takes its own address below.
                if !draft.isManual {
                    Section {
                        TextField(String(localized: "https://api.example.com/v1"), text: $draft.baseURL)
                            .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityLabel(String(localized: "Address"))
                    } header: {
                        Text(String(localized: "Address"))
                    }
                }
                Section {
                    // Write-only: no reveal control, and the key is never shown again.
                    SecureField(String(localized: "API key"), text: $draft.apiKey)
                        .textContentType(nil).textInputAutocapitalization(.never).autocorrectionDisabled()
                } header: {
                    Text(String(localized: "API key"))
                } footer: {
                    Text(String(localized: "Never shown again after saving; only its first and last characters are kept to recognize it."))
                }
                if let error {
                    Section { Text(error).font(.footnote).foregroundStyle(.red) }
                }
                if draft.isManual {
                    Section {
                        Text(String(localized: "You can also pick the protocols and enter the models yourself:"))
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(V2ModelProtocol.allCases, id: \.self) { format in
                        offerSection(format)
                    }
                }
            }
            .disabled(model.isCreatingProfile)
            .navigationTitle(String(localized: "Add profile")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetEditorToolbar(saveTitle: String(localized: "Save"), isWorking: model.isCreatingProfile,
                    workingTitle: draft.isManual ? nil : String(localized: "Detecting…"),
                    saveDisabled: !draft.isValid,
                    onCancel: { dismiss() },
                    onSave: { Task { await save() } })
            }
        }
        .appSheetPresentation(.expanded)
        .interactiveDismissDisabled(model.isCreatingProfile || draft != ModelProfileDraft())
    }

    private func offerSection(_ format: V2ModelProtocol) -> some View {
        Section {
            Toggle(ModelConfigPresentation.protocolLabel(format.rawValue), isOn: Binding(
                get: { draft.offer(format).enabled },
                set: { draft.offers[format, default: .init()].enabled = $0 }))
                .tint(.green)
            if draft.offer(format).enabled {
                TextField(String(localized: "https://api.example.com/v1"), text: Binding(
                    get: { draft.offer(format).baseURL },
                    set: { draft.offers[format, default: .init()].baseURL = $0 }))
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityLabel(String(localized: "Address"))
                TextField(String(localized: "One model ID per line; optional"), text: Binding(
                    get: { draft.offer(format).models },
                    set: { draft.offers[format, default: .init()].models = $0 }), axis: .vertical)
                    .font(.footnote.monospaced()).lineLimit(2...6)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityLabel(String(localized: "Models"))
            }
        }
    }

    private func save() async {
        error = nil
        guard let failure = await model.createProfile(draft) else { dismiss(); return }
        error = failure.message
        // An address the Server cannot detect from turns the form manual; a refused key does not.
        draft.fallBackToManual(after: failure.code)
    }
}
