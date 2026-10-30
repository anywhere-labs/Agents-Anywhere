import SwiftUI
import UIKit
import UniformTypeIdentifiers

private struct PlanMarkdownFile: FileDocument {
    static var readableContentTypes: [UTType] { [.plainText] }
    var text: String
    init(text: String) { self.text = text }
    init(configuration: ReadConfiguration) throws { text = String(data: configuration.file.regularFileContents ?? Data(), encoding: .utf8) ?? "" }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: Data(text.utf8)) }
}

private struct PlanCardEntry: Identifiable {
    let id: String
    var plan: V2PlanDocument? = nil
    var draft: V2PlanDraft? = nil
}

struct SessionPlanningPanel: View {
    let chat: SessionChatModel
    @State private var reader: V2PlanDocument?
    @State private var positions: [String: CGFloat] = [:]
    var body: some View {
        if let state = chat.session.planning, state.effectiveMode == "plan" || state.draft != nil || state.proposal != nil || state.proposals?.isEmpty == false {
            let entries = (state.proposals ?? [state.proposal].compactMap { $0 }).map { PlanCardEntry(id: $0.id, plan: $0) }
                + [state.draft].compactMap { $0 }.map { PlanCardEntry(id: "\($0.planId):\($0.revision)", draft: $0) }
            let status = [state.effectiveMode == "plan" ? "规划模式" : nil, state.execution.map { execution in
                execution.status == "started" ? "计划执行已开始" : execution.status == "accepted" ? "执行请求已接受，等待原生开始" : execution.status == "rejected" ? "计划已同意，执行尚未启动" : "执行结果待核对"
            }].compactMap { $0 }
            VStack(alignment: .leading, spacing: 12) {
                if !status.isEmpty {
                    Text(status.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                }
                ForEach(entries) { entry in
                    SessionPlanCard(entry: entry, onRead: { reader = $0 })
                }
            }.sheet(item: $reader) { plan in
                SessionPlanReader(plan: plan, offset: Binding(get: { positions[plan.id] ?? 0 }, set: { positions[plan.id] = $0 }))
            }
        }
    }
}

/// The card header already shows the title; drop a leading Markdown line that repeats it.
private func planPreviewBody(markdown: String, title: String) -> String {
    let text = markdown.replacingOccurrences(of: #"^\s*\n"#, with: "", options: .regularExpression)
    let lines = text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
    var heading = String(lines.first ?? "").replacingOccurrences(of: #"^#{1,6}\s+"#, with: "", options: .regularExpression)
    if heading.hasPrefix("**"), heading.hasSuffix("**"), heading.count >= 4 { heading = String(heading.dropFirst(2).dropLast(2)) }
    heading = heading.trimmingCharacters(in: .whitespaces)
    guard !heading.isEmpty, heading == title.trimmingCharacters(in: .whitespaces) else { return text }
    return (lines.count > 1 ? String(lines[1]) : "").replacingOccurrences(of: #"^\s*\n"#, with: "", options: .regularExpression)
}

private struct SessionPlanCard: View {
    let entry: PlanCardEntry
    let onRead: (V2PlanDocument) -> Void
    @State private var expanded = false
    @State private var contentHeight: CGFloat = 0
    @ScaledMetric(relativeTo: .body) private var previewHeight: CGFloat = 240
    private var collapsible: Bool { entry.plan != nil && contentHeight > previewHeight + 1 }
    private var clamped: Bool { collapsible && !expanded }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                AppSymbol("doc.text", size: 17).foregroundStyle(.secondary).padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    if let draft = entry.draft {
                        PlanWritingTitle(writing: draft.contentState == "drafting")
                    } else if let plan = entry.plan {
                        Text(plan.title).font(.subheadline.weight(.semibold)).accessibilityAddTraits(.isHeader)
                    }
                    Text(entry.plan.map { "计划 · 版本 \($0.revision)" } ?? "正文随原生计划输出更新").font(.caption).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
                if let plan = entry.plan {
                    Button("打开计划") { onRead(plan) }
                        .font(.subheadline).buttonStyle(.glass).buttonBorderShape(.capsule).controlSize(.small)
                        .frame(minHeight: 44)
                }
            }
            if let draft = entry.draft {
                ChatMarkdownView(text: draft.content, isStreaming: draft.contentState == "drafting")
            } else if let plan = entry.plan {
                ChatMarkdownView(text: planPreviewBody(markdown: plan.markdown, title: plan.title))
                    .fixedSize(horizontal: false, vertical: true)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
                    .frame(maxHeight: clamped ? previewHeight : nil, alignment: .top)
                    .clipped()
                    .mask {
                        LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: clamped ? 0.8 : 1), .init(color: clamped ? .clear : .black, location: 1)],
                            startPoint: .top, endPoint: .bottom)
                    }
                if collapsible {
                    Button {
                        withAnimation(.smooth(duration: 0.2)) { expanded.toggle() }
                    } label: {
                        Label(expanded ? "收起" : "展开全文", appSymbol: "chevron.down")
                    }
                    .font(.caption).foregroundStyle(.secondary).buttonStyle(.plain).frame(minHeight: 44)
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: 24))
    }
}

private struct PlanWritingTitle: View {
    let writing: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var visible = false
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 15, paused: !writing || !visible || reduceMotion || scenePhase != .active)) { context in
            Text(writing ? "正在撰写计划" : "计划草稿已中断").font(.subheadline.weight(.semibold))
                .opacity(!writing || reduceMotion || !visible || scenePhase != .active ? 1 : 0.78 + 0.22 * sin(context.date.timeIntervalSinceReferenceDate * .pi / 1.2))
        }.onScrollVisibilityChange { visible = $0 }
    }
}

private struct SessionPlanReader: View {
    let plan: V2PlanDocument
    @Binding var offset: CGFloat
    @State private var position = ScrollPosition(y: 0)
    @State private var exporting = false
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView { ChatMarkdownView(text: plan.markdown).padding(20) }.scrollPosition($position)
                .onAppear { position.scrollTo(y: offset) }
                .onScrollGeometryChange(for: CGFloat.self) { max(0, $0.contentOffset.y + $0.contentInsets.top) } action: { _, value in
                    if position.isPositionedByUser { offset = value }
                }
                .navigationTitle(plan.title).navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("关闭") { dismiss() } }
                    ToolbarItem(placement: .bottomBar) { Button("复制") { UIPasteboard.general.string = plan.markdown } }
                    ToolbarItem(placement: .bottomBar) { Button("导出 Markdown") { exporting = true } }
                    ToolbarItem(placement: .bottomBar) { ShareLink(item: plan.markdown) { Text("分享") } }
                }
                .fileExporter(isPresented: $exporting, document: PlanMarkdownFile(text: plan.markdown), contentType: UTType(filenameExtension: "md") ?? .plainText, defaultFilename: "PLAN.md") { _ in }
        }
    }
}

struct SessionPlanReviewPanel: View {
    let chat: SessionChatModel
    let target: V2PlanningState
    @State private var feedback = ""
    @State private var editing = false
    @State private var pending: String?
    @FocusState private var feedbackFocused: Bool
    private var open: Bool { target.review?.status == "open" }
    private var trimmedFeedback: String { feedback.trimmingCharacters(in: .whitespacesAndNewlines) }
    private func allowed(_ action: String) -> Bool {
        target.freshness == "fresh" && !target.epoch.isEmpty && target.capabilities?.actions.contains(action) == true && !chat.isWorking
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 8) {
                AppSymbol("checkmark.shield", size: 17).foregroundStyle(.secondary).padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    Text(open ? "是否执行这个计划？" : "计划已同意，执行尚未启动").font(.subheadline.weight(.semibold)).accessibilityAddTraits(.isHeader)
                    Text("版本 \(target.proposal?.revision ?? 1)").font(.caption).foregroundStyle(.secondary)
                    if target.freshness != "fresh" { Text("原生状态待核对，请刷新后再确认。").font(.caption).foregroundStyle(.secondary) }
                    if let error = chat.error { Text(error).font(.caption).foregroundStyle(.red) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            if editing {
                TextField("说明需要如何调整计划", text: $feedback, axis: .vertical)
                    .lineLimit(2...4).textFieldStyle(.roundedBorder).focused($feedbackFocused)
                    .disabled(chat.isWorking)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { actions }
                VStack(spacing: 8) { actions }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: 24))
        .padding(.horizontal, 12).padding(.vertical, 8)
        .onChange(of: editing) { _, value in feedbackFocused = value }
    }
    @ViewBuilder private var actions: some View {
        if !open {
            button("重试启动", "approve_and_execute", prominent: true)
        } else if editing {
            AppGlassButton("取消", disabled: chat.isWorking) { editing = false }.font(.subheadline)
            button("提交修改意见", "request_revision", prominent: true, extraDisabled: trimmedFeedback.isEmpty)
        } else {
            button("暂不执行", "dismiss_review")
            AppGlassButton("修改计划", disabled: !allowed("request_revision")) { editing = true }.font(.subheadline)
            button("同意并执行", "approve_and_execute", prominent: true)
        }
    }
    private func button(_ title: String, _ action: String, prominent: Bool = false, extraDisabled: Bool = false) -> some View {
        AppGlassButton(title, style: prominent ? .prominent : .regular, isLoading: chat.isWorking && pending == action,
            disabled: !allowed(action) || extraDisabled, maxWidth: .infinity) { respond(action) }
            .font(.subheadline)
    }
    private func respond(_ action: String) {
        pending = action
        Task {
            await chat.respondPlan(target, action: action, feedback: action == "request_revision" ? trimmedFeedback : "")
            pending = nil
            if action == "request_revision", chat.error == nil { editing = false; feedback = "" }
        }
    }
}
