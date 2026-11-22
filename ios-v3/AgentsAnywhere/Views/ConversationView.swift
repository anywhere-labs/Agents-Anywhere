import AAClientCore
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ConversationView: View {
    let deviceID: String
    let sessionID: String
    @Environment(AppModel.self) private var app
    @State private var model: ConversationModel?

    var body: some View {
        Group {
            if let model {
                ConversationScreen(model: model, deviceName: app.device(deviceID)?.name)
            } else {
                Color(.systemBackground)
            }
        }
        .onAppear {
            if model == nil { model = ConversationModel(app: app, deviceID: deviceID, sessionID: sessionID) }
            model?.start()
        }
        .onDisappear { model?.stop() }
    }
}

/// The WebView fills the screen and draws under the navigation bar and the bottom controls; the native controls are
/// sibling layers on top of it (never gesture recognizers on its ancestors) and their space is sent as
/// `theme.insets`, so content scrolls under the glass.
struct ConversationScreen: View {
    @Bindable var model: ConversationModel
    let deviceName: String?
    @State private var renaming = false
    @State private var controlsHeight: CGFloat = 0
    @State private var newTitle = ""

    var body: some View {
        RenderSurface(bridge: model.bridge, extraBottom: controlsHeight) { model.updateTheme($0) }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ConversationControls(model: model)
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { controlsHeight = $0 }
        }
        .errorToast($model.errorMessage)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    HStack(spacing: 4) {
                        Text(model.title).font(.headline).lineLimit(1)
                        if model.encrypted { LockView(badge: .green) }
                    }
                    Text(breadcrumb).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                .accessibilityElement(children: .combine)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        newTitle = model.session?.title ?? ""
                        renaming = true
                    } label: { Label("重命名", systemImage: "pencil") }
                    .disabled(model.readonly)
                    Button { UIPasteboard.general.string = model.sessionID } label: { Label("拷贝对话 ID", systemImage: "doc.on.doc") }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("更多")
            }
        }
        .alert("重命名对话", isPresented: $renaming) {
            TextField("标题", text: $newTitle)
            Button("取消", role: .cancel) {}
            Button("保存") { model.rename(newTitle) }
        }
    }

    private var breadcrumb: String {
        var parts: [String] = []
        if let deviceName { parts.append(deviceName) }
        if let session = model.session {
            parts.append(AgentStyle.name(session.agent))
            parts.append(ProjectPath.name(of: session.cwd))
        }
        return parts.joined(separator: " › ")
    }
}

/// Everything under the message flow: offline notice, queue, approval dock, composer.
struct ConversationControls: View {
    @Bindable var model: ConversationModel

    var body: some View {
        VStack(spacing: 8) {
            if case .offline(let reason) = model.connection {
                Label(model.cachedAt == nil ? reason : "\(reason) · 只读缓存", systemImage: "icloud.slash")
                    .font(.footnote)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .floatingSurface(cornerRadius: 14)
            } else if model.connection == .connecting && model.session == nil {
                ProgressView().padding(6)
            }
            if !model.control.queued.isEmpty {
                QueuedStrip(model: model)
            }
            if let pending = model.control.pending.first {
                ApprovalDock(model: model, request: pending, remaining: model.control.pending.count - 1)
            }
            ComposerView(model: model)
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 6)
        .overlay(alignment: .topTrailing) {
            if !model.atBottom {
                Button { model.scrollToBottom() } label: {
                    Image(systemName: "arrow.down").frame(width: 22, height: 22)
                }
                .glassCircle()
                .accessibilityLabel("回到底部")
                .padding(.trailing, 16)
                .offset(y: -52)
                .transition(.opacity)
            }
        }
        .animation(.snappy, value: model.atBottom)
        .animation(.snappy, value: model.control.pending.map(\.id))
    }
}

struct QueuedStrip: View {
    @Bindable var model: ConversationModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("排队中 \(model.control.queued.count)")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            ForEach(model.control.queued) { item in
                HStack(spacing: 8) {
                    Text(item.content.isEmpty ? "（附件）" : item.content)
                        .font(.subheadline)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if model.control.steer != "none" {
                        Button("插话") { model.steerQueued(item) }
                            .font(.caption)
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                    }
                    Button { model.unqueue(item) } label: { Image(systemName: "xmark") }
                        .font(.caption)
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .accessibilityLabel("移出队列")
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .floatingSurface(cornerRadius: 20)
    }
}

/// Fixed above the composer so a waiting approval never scrolls away with the messages.
struct ApprovalDock: View {
    @Bindable var model: ConversationModel
    let request: PendingRequest
    let remaining: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
                Text(request.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(3)
                Spacer(minLength: 0)
                if remaining > 0 {
                    Text("还有 \(remaining) 项").font(.caption).foregroundStyle(.secondary)
                }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(request.options) { option in
                        if option.isAllow {
                            Button(option.name) { model.answer(requestID: request.requestID, optionID: option.id) }
                                .buttonStyle(.borderedProminent)
                        } else {
                            Button(option.name, role: option.kind.hasPrefix("reject") ? .destructive : nil) {
                                model.answer(requestID: request.requestID, optionID: option.id)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }
            }
            .disabled(model.answering.contains(request.requestID) || model.readonly)
        }
        .padding(14)
        .floatingSurface(cornerRadius: 22)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("等待审批：\(request.title)")
    }
}

struct ComposerView: View {
    @Bindable var model: ConversationModel
    @FocusState private var focused: Bool
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showingPhotos = false
    @State private var showingFiles = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !model.attachments.isEmpty {
                AttachmentStrip(model: model)
            }
            TextField(model.readonly ? "设备离线，暂时不能发送" : "给 Agent 发消息", text: $model.draft, axis: .vertical)
                .lineLimit(1...6)
                .focused($focused)
                .disabled(model.readonly)
                .padding(.horizontal, 4)
            HStack(spacing: 8) {
                Menu {
                    Button { showingPhotos = true } label: { Label("照片", systemImage: "photo") }
                    Button { showingFiles = true } label: { Label("文件", systemImage: "doc") }
                } label: {
                    Image(systemName: "plus").frame(width: 20, height: 20)
                }
                .glassCircle()
                .disabled(model.readonly)
                .accessibilityLabel("添加附件")

                ConfigPickers(model: model)

                Spacer(minLength: 0)

                if model.control.isRunning {
                    Button { model.stopTurn() } label: {
                        Image(systemName: "stop.fill").frame(width: 20, height: 20)
                    }
                    .glassCircle()
                    .disabled(model.readonly)
                    .accessibilityLabel("停止")
                }
                SendButton(model: model)
            }
        }
        .padding(10)
        .floatingSurface(cornerRadius: 26)
        .photosPicker(isPresented: $showingPhotos, selection: $photoItems, maxSelectionCount: 6, matching: .images)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task { await loadPhotos(items) }
        }
        .fileImporter(isPresented: $showingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            for url in urls { loadFile(url) }
        }
    }

    private func loadPhotos(_ items: [PhotosPickerItem]) async {
        for (index, item) in items.enumerated() {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let type = item.supportedContentTypes.first ?? .jpeg
            let ext = type.preferredFilenameExtension ?? "jpg"
            let stamp = Int(Date().timeIntervalSince1970)
            model.attach(
                data: data, name: "photo-\(stamp)-\(index + 1).\(ext)", mime: type.preferredMIMEType ?? "image/jpeg",
                preview: UIImage(data: data)?.preparingThumbnail(of: CGSize(width: 120, height: 120)))
        }
    }

    private func loadFile(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else {
            model.errorMessage = "读不了「\(url.lastPathComponent)」"
            return
        }
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let preview = mime.hasPrefix("image/") ? UIImage(data: data)?.preparingThumbnail(of: CGSize(width: 120, height: 120)) : nil
        model.attach(data: data, name: url.lastPathComponent, mime: mime, preview: preview)
    }
}

/// Send. While the agent works: tap queues (or steers, if the agent takes steering natively); hold for the choice.
struct SendButton: View {
    @Bindable var model: ConversationModel

    var body: some View {
        if model.control.isRunning && model.control.steer != "none" {
            Menu {
                Button { model.send(.queue) } label: { Label("排队，等这一轮结束", systemImage: "text.badge.plus") }
                Button { model.send(.steer) } label: { Label("插话，打断当前这一轮", systemImage: "arrow.uturn.right") }
            } label: {
                icon
            } primaryAction: {
                model.send(.queue)
            }
            .prominentGlassCircle()
            .disabled(!model.canSend)
            .accessibilityLabel("发送（长按选择插话或排队）")
        } else {
            Button { model.send(.auto) } label: { icon }
                .prominentGlassCircle()
                .disabled(!model.canSend)
                .keyboardShortcut(.return, modifiers: .command)
                .accessibilityLabel("发送")
        }
    }

    private var icon: some View {
        Group {
            if model.sending { ProgressView().controlSize(.small) } else { Image(systemName: "arrow.up") }
        }
        .fontWeight(.semibold)
        .frame(width: 20, height: 20)
    }
}

struct AttachmentStrip: View {
    @Bindable var model: ConversationModel

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(model.attachments) { item in
                    HStack(spacing: 6) {
                        if let preview = item.preview {
                            Image(uiImage: preview).resizable().scaledToFill().frame(width: 28, height: 28).clipShape(.rect(cornerRadius: 6))
                        } else {
                            Image(systemName: "doc").frame(width: 28, height: 28)
                        }
                        VStack(alignment: .leading, spacing: 0) {
                            Text(item.name).font(.caption).lineLimit(1)
                            Group {
                                switch item.state {
                                case .uploading: Text("上传中…")
                                case .ready: Text(ByteCountFormatter.string(fromByteCount: Int64(item.size), countStyle: .file))
                                case .failed(let message): Text(message).foregroundStyle(.red)
                                }
                            }
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        }
                        .frame(maxWidth: 140, alignment: .leading)
                        Button { model.removeAttachment(item.id) } label: { Image(systemName: "xmark.circle.fill") }
                            .buttonStyle(.plain)
                            .foregroundStyle(.secondary)
                            .accessibilityLabel("移除 \(item.name)")
                    }
                    .padding(6)
                    .background(Color(.tertiarySystemFill), in: .rect(cornerRadius: 12))
                }
            }
        }
    }
}

/// The agent's own settings (model, mode, reasoning…) as compact menus.
struct ConfigPickers: View {
    @Bindable var model: ConversationModel

    var body: some View {
        let options = model.session?.config ?? []
        if !options.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(options) { option in
                        Menu {
                            Picker(option.name, selection: Binding(get: { option.current }, set: { model.setConfig(option, value: $0) })) {
                                ForEach(option.options) { choice in
                                    Text(choice.name).tag(choice.value)
                                }
                            }
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: symbol(option.category))
                                Text(option.currentName).lineLimit(1)
                            }
                            .font(.caption)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(Color(.tertiarySystemFill), in: .capsule)
                        }
                        .disabled(model.readonly)
                        .accessibilityLabel("\(option.name)：\(option.currentName)")
                    }
                }
            }
            .scrollClipDisabled()
        }
    }

    private func symbol(_ category: String?) -> String {
        switch category {
        case "model": "cpu"
        case "mode": "shield.lefthalf.filled"
        case "thought_level": "brain"
        default: "slider.horizontal.3"
        }
    }
}
