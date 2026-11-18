import PhotosUI
import SwiftUI
import UIKit

/// The conversation page's native chrome, drawn by SwiftUI in a layer above the WKWebView (never around it):
/// approval dock, composer, 到底部 pill, toasts, the renderer's loading / problem state, and the sheets. The layer is
/// a sibling of the web view inside `ConversationViewController`; it reports the frames of its controls
/// (`chromeRegion`), and only touches inside those reach it — every other touch goes to the web view, with no
/// SwiftUI gesture recognizer taking part.
struct ConversationChrome: View {
    @Bindable var controller: SessionController
    /// Frames of the controls, in this view's coordinate space (which is the hosting view's).
    let onRegions: ([String: CGRect]) -> Void

    @State private var editor = ComposerEditorController()
    @State private var showsOptions = false
    @State private var picker: AttachmentPicker?
    @State private var photos: [PhotosPickerItem] = []
    @State private var appliedDebugLaunch = false
    @ScaledMetric(relativeTo: .body) private var bodyLineHeight: CGFloat = 22
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.locale) private var locale

    private enum AttachmentPicker { case photos, files }

    private var bridge: RendererBridge { controller.bridge }
    private var controls: ChatControlMetrics { .init(bodyLineHeight: bodyLineHeight) }
    private var header: ConversationHeader { ConversationHeader(controller: controller) }

    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                toast
                Spacer(minLength: 0)
                // Its own row, directly above the bar: the pill's bottom is the bar's measured top minus 6 pt, whatever
                // the bar holds (dock or not, expanded composer, keyboard).
                endButton
                bottomBar(maximumEditorHeight: min(160, max(72, geometry.size.height * 0.30)))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay { rendererState }
        }
        .coordinateSpace(.named(ChromeRegion.space))
        .onPreferenceChange(ChromeRegion.Key.self) { regions in onRegions(regions) }
        .tint(AppTheme.primaryControlBackground(colorScheme))
        .sheet(isPresented: $showsOptions) {
            ComposerOptionsSheet(controller: controller,
                                 onPhotos: { showsOptions = false; picker = .photos },
                                 onFiles: { showsOptions = false; picker = .files })
        }
        .sheet(item: $controller.openRequest) { request in OpenTargetSheet(request: request) }
        .photosPicker(isPresented: pickerBinding(.photos), selection: $photos, maxSelectionCount: 5, matching: .images)
        .fileImporter(isPresented: pickerBinding(.files), allowedContentTypes: [.item], allowsMultipleSelection: true) { _ in
            controller.showToast("演示：附件不会上传")
        }
        .onChange(of: photos) { _, items in
            guard !items.isEmpty else { return }
            photos = []
            controller.showToast("演示：附件不会上传")
        }
        .onChange(of: controller.actionError) { _, message in
            guard let message else { return }
            controller.actionError = nil
            controller.showToast(message)
        }
        .onChange(of: appearanceKey, initial: true) { _, _ in sendAppearance() }
        .onChange(of: bridge.isReady) { _, ready in if ready { applyDebugLaunch() } }
    }

    // MARK: Top

    @ViewBuilder private var toast: some View {
        ZStack {
            if let toast = controller.toast {
                Text(toast)
                    .font(.subheadline.weight(.medium))
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .glassEffect(.regular, in: .capsule)
                    .onTapGesture { controller.toast = nil }
                    .chromeRegion("toast")
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(reduceMotion ? nil : .smooth(duration: 0.25), value: controller.toast)
    }

    @ViewBuilder private var rendererState: some View {
        switch bridge.phase {
        case .ready:
            EmptyView()
        case .loading:
            ProgressView().accessibilityLabel("正在加载渲染器")
        case .missing:
            RendererProblem(
                title: "缺少渲染器",
                message: "App 里没有 renderer.html。把渲染包构建到 v3poc/ios/AAv3PoC/Renderer/renderer.html 后重新构建，或用 AA_POC_RENDERER_PATH 指向一个本机文件。",
                onRetry: nil)
            .chromeRegion("problem")
        case let .failed(message):
            RendererProblem(title: "渲染器出错", message: message, onRetry: { bridge.load() })
                .chromeRegion("problem")
        }
    }

    // MARK: Bottom chrome

    private func bottomBar(maximumEditorHeight: CGFloat) -> some View {
        VStack(spacing: 10) {
            if let request = controller.pending {
                ApprovalDock(request: request, agentLabel: header.summary?.agentLabel ?? "Agent", count: controller.pendingCount,
                             enabled: header.deviceOnline) { option in
                    controller.answer(request.requestID, option: option)
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            ChatComposer(draft: controller.draft, editor: editor, isStreaming: controller.isRunning,
                         canSend: header.deviceOnline,
                         placeholder: header.deviceOnline ? "询问 Agents" : "设备离线，暂时不能发送",
                         maximumEditorHeight: maximumEditorHeight, controls: controls,
                         onSend: send, onStop: controller.stop, onOptions: { showsOptions = true })
        }
        .padding(.top, controller.pending == nil ? 0 : 8)
        .frame(maxWidth: ChatControlMetrics.maximumContentWidth)
        // What the thread must keep clear at the bottom (sent as `viewport.bottom`); not a touch region itself.
        .chromeRegion(ChromeRegion.bottomBar)
        .frame(maxWidth: .infinity)
        .animation(reduceMotion ? nil : .smooth(duration: 0.24), value: controller.pending?.requestID)
    }

    @ViewBuilder private var endButton: some View {
        ZStack {
            if bridge.showsEndButton {
                Button { bridge.scrollToEnd() } label: {
                    Label("到底部", appSymbol: "arrow.down")
                        .font(.footnote.weight(.medium))
                        .padding(.horizontal, 14).frame(minHeight: 34)
                        .glassEffect(.regular.interactive(), in: .capsule)
                        .frame(minHeight: 44).contentShape(.capsule)
                }
                .buttonStyle(.plain)
                .chromeRegion("pill")
                .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { StressMetrics.shared.uiFrame("pill", $0) }
                .onDisappear { StressMetrics.shared.uiFrame("pill", nil) }
                .padding(.bottom, 6)
                .transition(.scale(scale: 0.8).combined(with: .opacity))
                .accessibilityLabel("滚动到底部")
            }
        }
        .animation(reduceMotion ? nil : .smooth(duration: 0.2), value: bridge.showsEndButton)
    }

    private func send() {
        // Leave IME candidates alone; Return confirms them, the send button never guesses.
        guard editor.textView?.markedTextRange == nil else { return }
        editor.synchronize()
        controller.send()
    }

    private func pickerBinding(_ kind: AttachmentPicker) -> Binding<Bool> {
        Binding(get: { picker == kind }, set: { if !$0 { picker = nil } })
    }

    // MARK: Appearance

    private struct AppearanceKey: Equatable {
        let dark: Bool
        let size: DynamicTypeSize
        let reduceMotion: Bool
        let locale: String
    }

    private var appearanceKey: AppearanceKey {
        .init(dark: colorScheme == .dark, size: dynamicTypeSize, reduceMotion: reduceMotion, locale: locale.identifier(.bcp47))
    }

    private func sendAppearance() {
        // Relative to the default Dynamic Type size (Large): 1.0 by default, e.g. 1.24 at xxxLarge.
        let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(dynamicTypeSize))
        let scale = UIFontMetrics(forTextStyle: .body).scaledValue(for: 17, compatibleWith: traits) / 17
        bridge.setAppearance(dark: colorScheme == .dark, textScale: (scale * 100).rounded() / 100,
                             reduceMotion: reduceMotion, locale: locale.identifier(.bcp47),
                             accountName: controller.workspace.account.name)
    }

    // MARK: Debug launch

    private func applyDebugLaunch() {
        guard !appliedDebugLaunch else { return }
        appliedDebugLaunch = true
        Task {
            try? await Task.sleep(for: .milliseconds(900))
            if DebugLaunch.sheet == "options" { showsOptions = true }
            if DebugLaunch.focus { controller.draft.isFocused = true }
            if let backdrop = DebugLaunch.backdrop { bridge.debugBackdrop(backdrop) }
            if let points = DebugLaunch.scrollUp {
                try? await Task.sleep(for: .seconds(2))
                bridge.scrollUp(by: points)
            }
        }
    }
}

/// Frames of the chrome's controls: the only places where the chrome layer takes touches.
enum ChromeRegion {
    static let space = "aa.chrome"
    /// The dock + composer column, for `viewport.bottom`; the controls inside it report their own regions.
    static let bottomBar = "layout.bottomBar"

    struct Key: PreferenceKey {
        static let defaultValue: [String: CGRect] = [:]
        static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
            value.merge(nextValue()) { $1 }
        }
    }
}

extension View {
    func chromeRegion(_ name: String) -> some View {
        background {
            GeometryReader { proxy in
                Color.clear.preference(key: ChromeRegion.Key.self, value: [name: proxy.frame(in: .named(ChromeRegion.space))])
            }
        }
    }
}

private struct RendererProblem: View {
    let title: String
    let message: String
    let onRetry: (() -> Void)?

    var body: some View {
        VStack(spacing: 12) {
            AppSymbol("exclamationmark.triangle", size: 28).foregroundStyle(.orange)
            Text(title).font(.headline)
            Text(message).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            if let onRetry { Button("重试", action: onRetry).buttonStyle(.glass) }
        }
        .padding(28)
        .frame(maxWidth: 340)
        .glassEffect(.regular, in: .rect(cornerRadius: 28))
        .padding(24)
    }
}

/// `open` from the renderer: the page never navigates; the host shows the target (a real app previews the file
/// through the Connector or hands the URL to the system).
private struct OpenTargetSheet: View {
    let request: SessionController.OpenRequest
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text(verbatim: request.detail)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .background(.fill.tertiary, in: .rect(cornerRadius: 16))
                Text("演示：真实 App 会在这里通过设备预览文件，或交给系统打开链接。")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("复制", systemImage: "doc.on.doc") {
                    UIPasteboard.general.string = request.detail
                    dismiss()
                }
                .buttonStyle(.glass)
                Spacer(minLength: 0)
            }
            .padding(20)
            .navigationTitle(request.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetCloseToolbar { dismiss() } }
        }
        .presentationDetents([.medium])
    }
}
