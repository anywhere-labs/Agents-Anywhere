import SwiftUI

struct ComposerOptionsSheet: View {
    @Bindable var settings: ConversationSettings
    let onPhotos: () -> Void
    let onFiles: () -> Void
    var canAttach = true
    var canSelectModel = true
    var canSelectPermission = true
    var isLoading = false
    var loadingError: String?
    var onReload: () async -> Void = {}
    var onApply: () async -> Bool = { true }
    var applyError: () -> String? = { nil }
    var sessionChat: SessionChatModel?
    @State private var pendingTakeover: Bool?
    @State private var isApplying = false
    @State private var showsApplyError = false
    @State private var path: [Page] = []
    @State private var expandedModelID: String?
    @Environment(\.dismiss) private var dismiss

    private enum Page: Hashable { case models, permissions }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(spacing: 22) {
                    HStack(spacing: 12) {
                        attachmentTile(String(localized: "照片"), icon: "photo.on.rectangle", action: onPhotos)
                        attachmentTile(String(localized: "文件"), icon: "doc", action: onFiles)
                    }
                    .disabled(!canAttach)
                    .opacity(canAttach ? 1 : 0.5)
                    if !canAttach {
                        Text(String(localized: "当前运行状态不支持添加附件")).font(.footnote).foregroundStyle(.secondary)
                    }
                    if isLoading { ProgressView(String(localized: "加载对话选项…")) }
                    if let loadingError {
                        Text(loadingError).font(.footnote).foregroundStyle(.secondary)
                        Button(String(localized: "重新加载")) { Task { await onReload() } }
                    }
                    VStack(spacing: 0) {
                        NavigationLink(value: Page.models) {
                            optionRow(String(localized: "模型"), icon: "sparkles", value: settings.modelLabel)
                        }
                        .disabled(isLoading || !canSelectModel || settings.catalog.models.isEmpty)
                        Divider().padding(.leading, 52)
                        NavigationLink(value: Page.permissions) {
                            optionRow(String(localized: "权限"), icon: "checkmark.shield", value: settings.permission?.title ?? String(localized: "默认"))
                        }
                        .disabled(isLoading || !canSelectPermission || settings.catalog.permissions.isEmpty)
                    }
                    .background { ComposerOptionSurface() }
                    if let chat = sessionChat, let meta = chat.session.metadata {
                        VStack(alignment: .leading, spacing: 10) {
                            Toggle(isOn: Binding(get: { meta.takeover }, set: { pendingTakeover = $0 })) {
                                Label(String(localized: "接管会话"), appSymbol: "hand.raised")
                            }
                            .toggleStyle(.switch).tint(nil).accentColor(nil)
                            .disabled(!chat.canChangeTakeover)
                            Text(meta.takeover ? String(localized: "已开启，可从 Agents Anywhere 继续操作。") : String(localized: "只读模式，开启接管后可以继续发送消息。"))
                                .font(.footnote).foregroundStyle(.secondary)
                            if let error = chat.takeoverError {
                                Text(error).font(.footnote).foregroundStyle(.secondary)
                            }
                            if chat.takeoverUncertain || !chat.session.runtime.isFresh {
                                Button(String(localized: "刷新接管状态")) { Task { await chat.refreshTakeover() } }
                                    .font(.footnote).disabled(chat.isWorking || chat.session.network.availability == .offline)
                            }
                        }.padding(16).background { ComposerOptionSurface() }
                    }
                }
                .padding(20)
            }
            .buttonStyle(.plain)
            .navigationTitle(String(localized: "对话选项"))
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: Page.self) { page in
                switch page {
                case .models: models
                case .permissions: permissions
                }
            }
            .toolbar {
                SheetCloseToolbar(disabled: isApplying) { dismiss() }
            }
        }
        .appSheetPresentation(.compact)
        .disabled(isApplying)
        .interactiveDismissDisabled(isApplying)
        .modifier(SessionTakeoverConfirmation(pending: $pendingTakeover) { enabled in
            if let chat = sessionChat { _ = await chat.setTakeover(enabled) }
        })
        .alert(String(localized: "无法更改设置"), isPresented: $showsApplyError) {
            Button(String(localized: "好"), role: .cancel) {}
        } message: { Text(applyError() ?? String(localized: "当前设置未保存，请稍后重试。")) }
    }

    private func attachmentTile(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 12) {
                AppSymbol(icon, size: 27).foregroundStyle(.primary)
                Text(title).font(.subheadline.weight(.medium)).foregroundStyle(.primary)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 104)
            .background { ComposerOptionSurface() }
        }
        .accessibilityIdentifier(title == String(localized: "照片") ? "chat.options.photos" : "chat.options.files")
    }

    private func optionRow(_ title: String, icon: String, value: String) -> some View {
        HStack(spacing: 14) {
            AppSymbol(icon, size: 20).frame(width: 23)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.body)
                Text(value).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 8)
            AppSymbol("chevron.right", size: 14).foregroundStyle(.secondary)
        }
        .foregroundStyle(.primary)
        .padding(16)
        .contentShape(Rectangle())
    }

    private var models: some View {
        List {
            Section {
                ForEach(settings.catalog.models) { model in
                    if model.reasoning.isEmpty {
                        InlineSelectionButton(title: model.option.title, detail: detail(model.option),
                            isSelected: settings.modelID == model.id) {
                            apply { settings.selectModel(model.id) }
                        }
                        .disabled(!model.option.isEnabled)
                    } else {
                        InlineSelectionGroup(title: model.option.title, detail: detail(model.option),
                            isSelected: settings.modelID == model.id,
                            isExpanded: Binding(get: { expandedModelID == model.id }, set: { expandedModelID = $0 ? model.id : nil })) {
                            Text(String(localized: "思考强度"))
                                .font(.caption.weight(.medium)).foregroundStyle(.secondary)
                            ForEach(model.reasoning) { option in
                                InlineSelectionButton(title: option.title, detail: detail(option),
                                    isSelected: settings.modelID == model.id && settings.reasoningID == option.id) {
                                    apply { settings.selectModel(model.id, reasoning: option.id) }
                                }
                                .disabled(!option.isEnabled)
                            }
                        }
                        .disabled(!model.option.isEnabled)
                    }
                }
            } footer: {
                Text(String(localized: "选择模型后，可继续选择它支持的思考强度。"))
            }
        }
        .disabled(isLoading || !canSelectModel)
        .navigationTitle(String(localized: "模型"))
        .navigationBarTitleDisplayMode(.inline)
    }

    private var permissions: some View {
        List {
            Section {
                ForEach(settings.catalog.permissions) { option in
                    InlineSelectionButton(title: option.title, detail: detail(option),
                        isSelected: settings.permissionID == option.id) {
                        apply { settings.selectPermission(option.id) }
                    }
                    .disabled(!option.isEnabled)
                }
            } footer: {
                Text(String(localized: "用于这个对话接下来发送的消息。"))
            }
        }
        .disabled(isLoading || !canSelectPermission)
        .navigationTitle(String(localized: "权限"))
        .navigationBarTitleDisplayMode(.inline)
    }

    private func detail(_ option: CatalogOption) -> String {
        option.isEnabled ? option.detail : option.disabledReason ?? option.detail
    }

    private func apply(_ selection: () -> Bool) {
        guard !isApplying, selection() else { return }
        isApplying = true
        Task { @MainActor in
            let accepted = await onApply()
            isApplying = false
            if accepted { dismiss() } else { showsApplyError = true }
        }
    }
}

/// The root glass sheet uses fill contrast to distinguish its cards.
/// Selection pages use shared inline rows with the system list appearance.
private struct ComposerOptionSurface: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        let dark = colorScheme == .dark
        RoundedRectangle(cornerRadius: 22, style: .continuous)
            .fill((dark ? Color(white: 0.17) : Color.white)
                .opacity(reduceTransparency || contrast == .increased ? 1 : 0.92))
    }
}
