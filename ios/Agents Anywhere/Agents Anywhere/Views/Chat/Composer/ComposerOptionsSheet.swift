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
    @State private var isApplying = false
    @State private var showsApplyError = false
    @State private var path: [Page] = []
    @State private var detent: PresentationDetent = .medium
    @Environment(\.dismiss) private var dismiss

    private enum Page: Hashable { case models, reasoning(String), permissions }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(spacing: 22) {
                    HStack(spacing: 12) {
                        attachmentTile("照片", icon: "photo.on.rectangle", action: onPhotos)
                        attachmentTile("文件", icon: "doc", action: onFiles)
                    }
                    .disabled(!canAttach)
                    .opacity(canAttach ? 1 : 0.5)
                    if !canAttach {
                        Text("当前运行状态不支持添加附件").font(.footnote).foregroundStyle(.secondary)
                    }
                    if isLoading { ProgressView("加载对话选项…") }
                    if let loadingError {
                        Text(loadingError).font(.footnote).foregroundStyle(.secondary)
                        Button("重新加载") { Task { await onReload() } }
                    }
                    VStack(spacing: 0) {
                        NavigationLink(value: Page.models) {
                            optionRow("模型", icon: "sparkles", value: settings.modelLabel)
                        }
                        .disabled(isLoading || !canSelectModel || settings.catalog.models.isEmpty)
                        Divider().padding(.leading, 52)
                        NavigationLink(value: Page.permissions) {
                            optionRow("权限", icon: "checkmark.shield", value: settings.permission?.title ?? "默认")
                        }
                        .disabled(isLoading || !canSelectPermission || settings.catalog.permissions.isEmpty)
                    }
                    .background { ComposerOptionSurface() }
                }
                .padding(20)
            }
            .buttonStyle(.plain)
            .navigationTitle("对话选项")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: Page.self) { page in
                switch page {
                case .models: models
                case .permissions: permissions
                case .reasoning(let id): reasoning(for: id)
                }
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("关闭", systemImage: "xmark") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
        .disabled(isApplying)
        .interactiveDismissDisabled(isApplying)
        .alert("无法更改设置", isPresented: $showsApplyError) {
            Button("好", role: .cancel) {}
        } message: { Text(applyError() ?? "当前设置未保存，请稍后重试。") }
        .onChange(of: path) { _, pages in
            withAnimation(.smooth(duration: 0.25)) { detent = pages.isEmpty ? .medium : .large }
        }
    }

    private func attachmentTile(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 12) {
                Image(systemName: icon).font(.system(size: 27, weight: .regular)).foregroundStyle(.blue)
                Text(title).font(.subheadline.weight(.medium)).foregroundStyle(.primary)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 104)
            .background { ComposerOptionSurface() }
        }
        .accessibilityIdentifier(title == "照片" ? "chat.options.photos" : "chat.options.files")
    }

    private func optionRow(_ title: String, icon: String, value: String) -> some View {
        HStack(spacing: 14) {
            Image(systemName: icon).font(.system(size: 20)).frame(width: 23)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.body)
                Text(value).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
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
                        Button {
                            apply { settings.selectModel(model.id) }
                        } label: { selectionRow(model.option, selected: settings.modelID == model.id) }
                        .disabled(!model.option.isEnabled)
                    } else {
                        NavigationLink(value: Page.reasoning(model.id)) {
                            selectionRow(model.option, selected: settings.modelID == model.id)
                        }
                        .disabled(!model.option.isEnabled)
                    }
                }
            } footer: {
                Text("选择模型后，可继续选择它支持的思考强度。")
            }
        }
        .navigationTitle("模型")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder private func reasoning(for id: String) -> some View {
        if let model = settings.catalog.models.first(where: { $0.id == id }) {
            List {
                Section(model.option.title) {
                    ForEach(model.reasoning) { option in
                        Button {
                            apply { settings.selectModel(id, reasoning: option.id) }
                        } label: {
                            selectionRow(option, selected: settings.modelID == id && settings.reasoningID == option.id)
                        }
                        .disabled(!model.option.isEnabled || !option.isEnabled)
                    }
                }
            }
            .navigationTitle("思考强度")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var permissions: some View {
        List {
            Section {
                ForEach(settings.catalog.permissions) { option in
                    Button {
                        apply { settings.selectPermission(option.id) }
                    } label: { selectionRow(option, selected: settings.permissionID == option.id) }
                    .disabled(!option.isEnabled)
                }
            } footer: {
                Text("用于这个对话接下来发送的消息。")
            }
        }
        .navigationTitle("权限")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func selectionRow(_ option: CatalogOption, selected: Bool) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(option.title).foregroundStyle(.primary)
                let detail = option.isEnabled ? option.detail : option.disabledReason ?? option.detail
                if !detail.isEmpty { Text(detail).font(.footnote).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 8)
            if selected { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(.blue) }
        }
        .padding(.vertical, 7)
        .opacity(option.isEnabled ? 1 : 0.5)
        .contentShape(Rectangle())
        .accessibilityAddTraits(selected ? .isSelected : [])
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
/// Pushed selection pages retain their standard system list appearance.
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
