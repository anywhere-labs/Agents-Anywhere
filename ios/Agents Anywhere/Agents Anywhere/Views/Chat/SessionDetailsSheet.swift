import SwiftUI
import UniformTypeIdentifiers

struct SessionDetailsSheet: View {
    let chat: SessionChatModel
    let service: V2SessionDetailService
    @Environment(\.dismiss) private var dismiss
    @State private var exportRequest: String?
    @State private var document: TimelineJSONDocument?
    @State private var showsExporter = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            List {
                if let meta = chat.session.metadata {
                    Section("会话") {
                        row("标题", meta.title ?? "未命名会话")
                        row("设备", meta.connectorId)
                        row("Agent", meta.runtimeName ?? meta.runtime)
                        row("Agent 类型", meta.runtimeTypeDisplayName ?? meta.runtimeType ?? meta.runtime)
                        row("状态", chat.session.runtime.state?.status.rawValue ?? meta.status.rawValue)
                        row("工作目录", meta.cwd ?? "无")
                        row("接管", meta.takeover ? "已开启" : "只读")
                    }
                    Section("标识与时间线") {
                        row("Session ID", meta.id)
                        row("外部 Session ID", meta.externalSessionId ?? "无")
                        row("已加载条目", String(chat.session.timeline.count))
                        row("待回应交互", String(chat.session.notices.notices.filter { $0.isVisible && $0.notice.type == "interaction" }.count))
                    }
                    Section {
                        Button { exportRequest = "memory" } label: { Label("导出已加载时间线 JSON", systemImage: "square.and.arrow.up") }
                            .disabled(exportRequest != nil)
                        Button { exportRequest = "remote" } label: { Label("导出服务器时间线 JSON", systemImage: "arrow.down.document") }
                            .disabled(exportRequest != nil || chat.session.network.availability == .offline)
                        if exportRequest != nil {
                            HStack { ProgressView(); Text("正在准备导出…"); Spacer(); Button("取消") { exportRequest = nil } }
                        }
                    } footer: {
                        Text("已加载导出保留当前缓存窗口；服务器导出会单独分页读取完整时间线，不改变你正在查看的位置。")
                    }
                }
                if let error { Section { Text(error).foregroundStyle(.secondary) } }
            }
            .navigationTitle("会话详情").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("关闭", systemImage: "xmark") { dismiss() } } }
        }
        .presentationDetents([.large])
        .task(id: exportRequest) {
            guard let source = exportRequest, let meta = chat.session.metadata else { return }
            error = nil
            do {
                let export: SessionTimelineExport
                if source == "remote" { export = try await service.exportTimeline(sessionId: meta.id) }
                else {
                    let items = chat.session.timeline.map(\.value)
                    export = SessionTimelineExport(source: "memory", session: meta, items: items, notices: chat.session.runtime.notices,
                        nextSeq: items.map(\.updatedSeq).max() ?? 0, hasMore: chat.session.hasOlderItems || chat.session.hasNewerItems)
                }
                try Task.checkCancellation()
                guard chat.session.isValid else { return }
                document = TimelineJSONDocument(data: try export.encoded(), name: "timeline-\(source)-\(meta.id.prefix(8))")
                showsExporter = true
            } catch is CancellationError { }
            catch { if !Task.isCancelled { self.error = error.localizedDescription } }
            if !Task.isCancelled { exportRequest = nil }
        }
        .fileExporter(isPresented: $showsExporter, document: document, contentType: .json, defaultFilename: document?.name ?? "timeline") { result in
            if case let .failure(failure) = result { error = failure.localizedDescription }
            document = nil
        }
    }
    private func row(_ title: String, _ value: String) -> some View {
        LabeledContent(title) { Text(value).textSelection(.enabled).font(.subheadline).multilineTextAlignment(.trailing) }
    }
}

private struct TimelineJSONDocument: FileDocument {
    static let readableContentTypes: [UTType] = [.json]
    let data: Data
    let name: String
    init(data: Data, name: String) { self.data = data; self.name = name }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data(); name = "timeline" }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}
