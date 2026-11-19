import PhotosUI
import SwiftUI

/// The real app's `ComposerOptionsSheet`: photo/file tiles, then one row per `session.config` option (generic over
/// v3 `ConfigOption`, nothing keyed on the agent), then context usage from `control.usage`.
struct ComposerOptionsSheet: View {
    let controller: SessionController
    let onPhotos: () -> Void
    let onFiles: () -> Void
    @State private var path: [String] = []
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(spacing: 22) {
                    HStack(spacing: 12) {
                        attachmentTile("照片", icon: "photo.on.rectangle", action: onPhotos)
                        attachmentTile("文件", icon: "doc", action: onFiles)
                    }
                    let config = controller.config
                    if !config.isEmpty {
                        VStack(spacing: 0) {
                            ForEach(Array(config.enumerated()), id: \.element.id) { index, option in
                                if index > 0 { Divider().padding(.leading, 52) }
                                NavigationLink(value: option.id) {
                                    optionRow(option.name, icon: Self.icon(option.category), value: option.currentName)
                                }
                            }
                        }
                        .background { ComposerOptionSurface() }
                    } else {
                        Text("Agent 还没有报告可调整的设置").font(.footnote).foregroundStyle(.secondary)
                    }
                    if let usage = controller.usage {
                        HStack(spacing: 14) {
                            ContextRing(fraction: usage).frame(width: 23, height: 23)
                            VStack(alignment: .leading, spacing: 5) {
                                Text("上下文").font(.body)
                                Text(usageText).font(.subheadline).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(16)
                        .background { ComposerOptionSurface() }
                    }
                }
                .padding(20)
            }
            .buttonStyle(.plain)
            .navigationTitle("对话选项")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { id in
                if let option = controller.config.first(where: { $0.id == id }) { values(option) }
            }
            .toolbar { SheetCloseToolbar { dismiss() } }
        }
        .appSheetPresentation(.compact)
    }

    private var usageText: String {
        guard let used = controller.control?["usage"]?["used"]?.double, let size = controller.control?["usage"]?["size"]?.double else { return "" }
        return "\(Int((used / size * 100).rounded()))% · \(Int(used / 1000))k / \(Int(size / 1000))k tokens"
    }

    static func icon(_ category: String?) -> String {
        switch category {
        case "model": "sparkles"
        case "mode": "checkmark.shield"
        case "thought_level": "bolt"
        default: "slider.horizontal.3"
        }
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

    private func values(_ option: ConfigOption) -> some View {
        List {
            Section {
                ForEach(option.options) { value in
                    InlineSelectionButton(title: value.name, detail: value.description, isSelected: value.value == option.current) {
                        controller.setConfig(option.id, value: value.value)
                        path.removeAll()
                    }
                }
            } footer: {
                if let description = option.options.first(where: { $0.value == option.current })?.description {
                    Text(description)
                }
            }
        }
        .navigationTitle(option.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// The root glass sheet uses fill contrast to distinguish its cards.
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

/// Context window usage (`control.usage.used / size`).
struct ContextRing: View {
    let fraction: Double
    var body: some View {
        ZStack {
            Circle().stroke(.secondary.opacity(0.25), lineWidth: 3)
            Circle().trim(from: 0, to: min(max(fraction, 0), 1))
                .stroke(fraction > 0.8 ? Color.orange : Color.primary, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .accessibilityLabel("上下文已用 \(Int(fraction * 100))%")
    }
}
