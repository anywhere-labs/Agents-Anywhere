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
                    Section(String(localized: "会话")) {
                        row(String(localized: "标题"), meta.title ?? String(localized: "未命名会话"))
                        row(String(localized: "设备"), meta.connectorId)
                        row(String(localized: "Agent"), meta.runtimeName ?? meta.runtime)
                        row(String(localized: "Agent 类型"), meta.runtimeTypeDisplayName ?? meta.runtimeType ?? meta.runtime)
                        row(String(localized: "状态"), (chat.session.runtime.state?.status ?? meta.status).displayName)
                        row(String(localized: "dashboard.session.workspace"), meta.cwd ?? String(localized: "无"))
                        row(String(localized: "接管"), meta.takeover ? String(localized: "已开启") : String(localized: "只读"))
                    }
                    Section(String(localized: "标识与时间线")) {
                        row(String(localized: "Session ID"), meta.id)
                        row(String(localized: "外部 Session ID"), meta.externalSessionId ?? String(localized: "无"))
                        row(String(localized: "已加载条目"), String(chat.session.timeline.count))
                        row(String(localized: "待回应交互"), String(chat.session.notices.notices.filter { $0.isVisible && $0.notice.type == "interaction" }.count))
                    }
                    Section {
                        Button { exportRequest = "memory" } label: { Label(String(localized: "导出已加载时间线 JSON"), appSymbol: "square.and.arrow.up") }
                            .disabled(exportRequest != nil)
                        Button { exportRequest = "remote" } label: { Label(String(localized: "导出服务器时间线 JSON"), appSymbol: "arrow.down.document") }
                            .disabled(exportRequest != nil || chat.session.network.availability == .offline)
                        if exportRequest != nil {
                            HStack { ProgressView(); Text(String(localized: "正在准备导出…")); Spacer(); Button(String(localized: "取消")) { exportRequest = nil } }
                        }
                    }
                }
                if let error { Section { Text(error).foregroundStyle(.secondary) } }
            }
            .navigationTitle(String(localized: "会话详情")).navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetCloseToolbar { dismiss() } }
        }
        .appSheetPresentation(.expanded)
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
