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

/// 「模型渠道」, as on the desktop: every channel in a list, each opening its
/// own page, so the list stays short however many runtimes there are.
private struct ModelConfigPage: View {
    @StateObject private var storage: StableViewModel<ModelConfigModel>
    @State private var linker = TokensLinkCoordinator()
    @State private var creating = false

    init(services: V2ClientServices) {
        _storage = StateObject(wrappedValue: StableViewModel {
            ModelConfigModel(api: services.modelConfigAPI, dashboard: services.dashboardRepository)
        })
    }

    private var model: ModelConfigModel { storage.value }

    var body: some View {
        List {
            ModelConfigFeedbackSection(model: model)
            if let overview = model.overview {
                if !overview.secretConfigured { SecretMissingSection() }
                Section {
                    channelLink(V2ModelChannel.native)
                    if overview.tokens?.available == true { channelLink(V2ModelChannel.tokens) }
                }
                // The active Tokens profile belongs to the Tokens Anywhere channel.
                let listed = overview.profiles.filter { !($0.isTokens && $0.isActive) }
                let enabled = listed.filter(\.isActive)
                let detached = listed.filter { !$0.isActive }
                if !enabled.isEmpty {
                    Section {
                        ForEach(enabled) { profile in channelLink(profile.id) }
                    } header: {
                        Text(String(localized: "pages.settings.modelConfigs.channels.manual"))
                    }
                }
                if !detached.isEmpty {
                    Section {
                        ForEach(detached) { profile in channelLink(profile.id) }
                    } header: {
                        Text(String(localized: "pages.settings.modelConfigs.channels.detached"))
                    }
                }
                Section {
                    Button {
                        creating = true
                    } label: {
                        Label(String(localized: "Add profile"), appSymbol: "plus")
                    }
                    .disabled(!overview.secretConfigured || !model.canWrite)
                }
            } else {
                Section {
                    HStack { Spacer(); ProgressView(); Spacer() }.padding(.vertical, 24)
                }
            }
        }
        // Reading the state also lets the Server resume switches waiting for this moment.
        .task { await model.refreshChannel() }
        .sheet(isPresented: $creating) { ModelProfileEditorSheet(model: model) }
    }

    private func channelLink(_ id: String) -> some View {
        NavigationLink {
            ChannelDetailView(model: model, channelId: id, linker: linker)
        } label: {
            ChannelListRow(model: model, channelId: id)
        }
    }
}

/// A channel in the list: its name, whether it is applied, and how many runtimes should use it.
private struct ChannelListRow: View {
    let model: ModelConfigModel
    let channelId: String

    var body: some View {
        let progress = ChannelPresentation.progress(model.channelRows(channelId))
        HStack(spacing: 8) {
            Text(verbatim: model.channelLabel(channelId)).lineLimit(1)
            if model.isCurrentChannel(channelId) {
                ModelStatusBadge(title: String(localized: "pages.settings.modelConfigs.current.inUse"), tone: .ok)
            }
            Spacer(minLength: 8)
            if progress.phase != .none {
                HStack(spacing: 5) {
                    if progress.phase == .running {
                        ProgressView().controlSize(.mini)
                            .accessibilityLabel(Text(String(localized: "pages.settings.modelConfigs.runtimes.switching")))
                    }
                    if progress.phase == .attention {
                        Circle().fill(.orange).frame(width: 8, height: 8)
                            .accessibilityLabel(Text(String(localized: "pages.settings.modelConfigs.runtimes.attention")))
                    }
                    Text(verbatim: "\(progress.total)").font(.subheadline).foregroundStyle(.secondary).monospacedDigit()
                }
            }
        }
    }
}

/// The last action's outcome; it goes away on its own.
struct ModelConfigFeedbackSection: View {
    let model: ModelConfigModel

    var body: some View {
        if let feedback = model.feedback {
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
    }
}

struct SecretMissingSection: View {
    var body: some View {
        Section {
            Label(String(localized: "The server has no AGENT_SERVER_SECRET (at least 32 characters) yet. Ask an administrator to set it before saving keys or linking Tokens Anywhere."),
                appSymbol: "exclamationmark.triangle")
                .font(.footnote).foregroundStyle(.secondary)
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
