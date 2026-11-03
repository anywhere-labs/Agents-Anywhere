import SwiftUI

/// 「配置管理」: model profiles, where they are applied, and the Tokens Anywhere
/// link. Everything renders from runtime capabilities, never runtime names.
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
    @State private var applying: V2ModelProfile?
    @State private var confirmsUnlink = false
    @State private var unlinkAllowsInterrupt = false
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
                if let tokens = overview.tokens, tokens.available {
                    TokensQuickSetupSection(model: model, tokens: tokens, linker: linker,
                        confirmsUnlink: $confirmsUnlink, unlinkAllowsInterrupt: $unlinkAllowsInterrupt)
                }
                profilesSection(overview)
                devicesSection(overview)
            } else {
                Section {
                    HStack { Spacer(); ProgressView(); Spacer() }.padding(.vertical, 24)
                }
            }
        }
        // The browser sheet covers this page, so leaving it open is not a reason
        // to cancel; the next snapshot that shows the link closes it.
        .onChange(of: model.overview?.tokens?.link) { _, link in
            linker.observe(link)
            if link?.isLinked == true { model.finishAuthorizing() }
        }
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
            else if model.account.tab == nil { model.account.tab = model.initialAccountTab }
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
        .sheet(item: $applying) { profile in ModelApplySheet(model: model.makeApplyModel(profile: profile)) { operation in
            model.feedback = ModelConfigPresentation.operationMessage(operation)
        } }
        .confirmationDialog(String(localized: "Unlink Tokens Anywhere?"), isPresented: $confirmsUnlink, titleVisibility: .visible) {
            Button(String(localized: "Unlink"), role: .destructive) {
                let allow = unlinkAllowsInterrupt
                Task { await model.unlinkTokens(allowInterrupt: allow) }
            }
            Button(String(localized: "Cancel"), role: .cancel) {}
        } message: {
            Text(String(localized: "The \(tokensUsage) runtimes using this profile go back to their previous configuration first, then the authorization is revoked and the key stops working."))
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
    }

    /// The linked account's page is showing.
    private var showsAccount: Bool {
        model.overview?.tokens?.available == true && model.quickPhase == .done
    }

    /// Changes when another account's page shows; nil while none does.
    private var accountKey: String? {
        showsAccount ? model.overview?.tokens?.link?.account.id ?? "" : nil
    }

    /// Changes when the usage tab opens or its period changes; nil while it is closed.
    private var usageKey: String? {
        guard let account = accountKey, model.account.tab == .usage else { return nil }
        return "\(account)#\(model.account.usageDays)"
    }

    private var tokensUsage: Int {
        guard let overview = model.overview, let profile = overview.activeTokensProfile else { return 0 }
        return overview.usage(of: profile.id)
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
            ForEach(overview.profiles) { profile in
                profileRow(profile, usedBy: overview.usage(of: profile.id))
            }
            Button {
                creating = true
            } label: {
                Label(String(localized: "Add profile"), appSymbol: "plus")
            }
            .disabled(!overview.secretConfigured || !model.canWrite)
        } header: {
            Text(String(localized: "Model profiles"))
        } footer: {
            Text(String(localized: "A model service's address, key and models. Keys are write-only and never shown again."))
        }
    }

    private func profileRow(_ profile: V2ModelProfile, usedBy: Int) -> some View {
        let busy = model.busyProfileID == profile.id
        let canDelete = profile.source == "manual" || !profile.isActive
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(profile.name).font(.body.weight(.semibold))
                    // The Tokens profile is already named after its source.
                    let source = ModelConfigPresentation.sourceLabel(profile.source)
                    if source != profile.name { ModelStatusBadge(title: source, tone: .neutral) }
                    if !profile.isActive { ModelStatusBadge(title: String(localized: "Unlinked"), tone: .warning) }
                }
                ModelProfileDetails(profile: profile, usedBy: usedBy)
            }
            Spacer(minLength: 0)
            if busy { ProgressView() }
            Menu {
                Button(String(localized: "Apply to devices"), systemImage: "arrow.up.circle") { applying = profile }
                    .disabled(!profile.isActive || !model.canWrite)
                if profile.isTokens && profile.isActive {
                    Button(String(localized: "Rotate key"), systemImage: "key") { rotating = profile }
                        .disabled(!model.canWrite)
                }
                if canDelete {
                    Divider()
                    Button(String(localized: "Delete profile"), systemImage: "trash", role: .destructive) { deleting = profile }
                        .disabled(usedBy > 0 || !model.canWrite)
                }
            } label: {
                AppSymbol("ellipsis", size: 18).foregroundStyle(.secondary)
                    .frame(width: 36, height: 44).contentShape(.rect)
            }
            .buttonStyle(.plain).disabled(model.busyProfileID != nil)
            .accessibilityLabel(Text(profile.name))
        }
        .swipeActions(edge: .trailing) {
            if profile.isActive {
                Button(String(localized: "Apply to devices")) { applying = profile }.tint(.accentColor)
            }
        }
    }

    // MARK: Devices

    private func devicesSection(_ overview: V2ModelConfigOverview) -> some View {
        Section {
            let rows = model.rows
            if rows.isEmpty {
                Text(String(localized: "No runtimes take a model connection yet.")).font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(rows) { row in deviceRow(row) }
        } header: {
            Text(String(localized: "Devices"))
        } footer: {
            Text(String(localized: "Runtimes on your devices that take a model connection. “Applied” means the runtime took the configuration, not that the connection was verified."))
        }
    }

    private func deviceRow(_ row: ModelRuntimeRow) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(row.runtime.sessionDisplayName).font(.body.weight(.semibold)).lineLimit(1)
                RuntimeMaturityBadge(maturity: row.runtime.badgeMaturity)
                if row.isManagedInstance { ModelStatusBadge(title: String(localized: "Created here"), tone: .neutral) }
                Spacer(minLength: 0)
            }
            Text(row.deviceName).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            Text(rowDetail(row)).font(.footnote).foregroundStyle(.secondary).lineLimit(3)
            HStack(spacing: 6) {
                if let assignment = row.assignment, assignment.status != "applied" {
                    ModelStatusBadge(title: ModelConfigPresentation.assignmentStatusLabel(assignment.status),
                        tone: ModelConfigPresentation.assignmentTone(assignment.status))
                }
                if let status = row.status {
                    ModelStatusBadge(title: ModelConfigPresentation.connectionStateLabel(status.state),
                        tone: ModelConfigPresentation.connectionTone(status.state))
                }
                Spacer(minLength: 0)
                if let assignment = row.assignment {
                    Button {
                        Task { await model.restore(assignment) }
                    } label: {
                        if model.restoringID == assignment.id { ProgressView() }
                        else { Label(String(localized: "pages.settings.modelConfigs.restore"), appSymbol: "arrow.counterclockwise").font(.footnote) }
                    }
                    .buttonStyle(.borderless)
                    .disabled(model.restoringID != nil || !model.canWrite)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func rowDetail(_ row: ModelRuntimeRow) -> String {
        var text = row.assignment.map { String(localized: "Uses “\(model.profileName($0.profileId))”") }
            ?? String(localized: "Not managed here")
        if let reason = row.status?.reason, !reason.isEmpty { text += " · " + reason }
        return text
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
                    Text(String(localized: "Enter the service's key and the protocols, addresses and models it offers."))
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
                ForEach(V2ModelProtocol.allCases, id: \.self) { format in
                    offerSection(format)
                }
                if let error {
                    Section { Text(error).font(.footnote).foregroundStyle(.red) }
                }
            }
            .disabled(model.isCreatingProfile)
            .navigationTitle(String(localized: "Add profile")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetEditorToolbar(saveTitle: String(localized: "Save"), isWorking: model.isCreatingProfile,
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
                TextField(String(localized: "https://example.com/v1"), text: Binding(
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
        error = await model.createProfile(draft)
        if error == nil { dismiss() }
    }
}

// MARK: - Apply

private struct ModelApplySheet: View {
    @State private var model: ModelApplyModel
    let onApplied: (V2ModelOperation) -> Void
    @Environment(\.dismiss) private var dismiss

    init(model: ModelApplyModel, onApplied: @escaping (V2ModelOperation) -> Void) {
        _model = State(initialValue: model)
        self.onApplied = onApplied
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(String(localized: "Choose the runtimes that should use this profile. Only instances AA manages change by default; changing a runtime's own global settings needs separate confirmation."))
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let targets = model.targets {
                    if targets.isEmpty {
                        Section { Text(String(localized: "No runtimes can take this profile.")).foregroundStyle(.secondary) }
                    } else {
                        Section {
                            ForEach(targets) { target in targetRow(target) }
                        }
                    }
                    if model.interruptedSessions > 0 {
                        Section {
                            Toggle(String(localized: "Allow interrupting running tasks"), isOn: $model.allowInterrupt).tint(.green)
                        } footer: {
                            Text(String(localized: "Applying restarts the runtime and interrupts \(model.interruptedSessions) running tasks."))
                        }
                    }
                    if model.needsNativeGlobal {
                        Section {
                            Toggle(isOn: $model.confirmNativeGlobal) {
                                Text(String(localized: "I confirm changing the selected runtimes' own global settings, which also affects using them outside AA."))
                                    .font(.footnote)
                            }
                            .tint(.orange)
                        }
                    }
                } else if let error = model.loadError {
                    Section { Text(error).foregroundStyle(.red) }
                } else {
                    Section { HStack { Spacer(); ProgressView(); Spacer() }.padding(.vertical, 24) }
                }
                if let error = model.applyError {
                    Section { Text(error).font(.footnote).foregroundStyle(.red) }
                }
            }
            .disabled(model.isApplying)
            .navigationTitle(Text(String(localized: "Apply “\(model.profile.name)”")))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetEditorToolbar(saveTitle: String(localized: "Apply to \(model.chosen.count)"), isWorking: model.isApplying,
                    saveDisabled: !model.canApply,
                    onCancel: { dismiss() },
                    onSave: {
                        Task {
                            if let operation = await model.apply() {
                                onApplied(operation)
                                dismiss()
                            }
                        }
                    })
            }
            .task { await model.load() }
        }
        .appSheetPresentation(.expanded)
        .interactiveDismissDisabled(model.isApplying)
    }

    private func targetRow(_ target: V2ModelPreviewTarget) -> some View {
        Toggle(isOn: Binding(get: { model.selected.contains(target.id) }, set: { model.toggle(target, $0) })) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(target.name ?? target.runtimeId).font(.body.weight(.semibold)).lineLimit(1)
                    RuntimeMaturityBadge(maturity: target.capabilityMaturity ?? target.maturity)
                }
                Text(model.deviceName(target.connectorId)).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                Text(ModelConfigPresentation.previewDetail(target)).font(.footnote).foregroundStyle(.secondary)
            }
        }
        .tint(.green)
        .disabled(!target.canApply)
    }
}
