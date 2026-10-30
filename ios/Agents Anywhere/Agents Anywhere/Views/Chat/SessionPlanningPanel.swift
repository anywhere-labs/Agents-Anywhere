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
            VStack(alignment: .leading, spacing: 12) {
                Text(state.effectiveMode == "plan" ? "规划模式" : "计划").font(.caption).foregroundStyle(.secondary)
                if let execution = state.execution {
                    Text(execution.status == "started" ? "计划执行已开始" : execution.status == "accepted" ? "执行请求已接受，等待原生开始" : execution.status == "rejected" ? "计划已同意，执行尚未启动" : "执行结果待核对").font(.caption)
                }
                ForEach(entries) { entry in
                    VStack(alignment: .leading, spacing: 12) {
                        if let draft = entry.draft {
                            PlanWritingTitle(writing: draft.contentState == "drafting")
                            ChatMarkdownView(text: draft.content, isStreaming: draft.contentState == "drafting")
                        }
                        if let plan = entry.plan {
                            Label(plan.title, systemImage: "doc.text").font(.headline)
                            Text("计划 · 版本 \(plan.revision)").font(.caption).foregroundStyle(.secondary)
                            ChatMarkdownView(text: plan.markdown).frame(maxHeight: 240, alignment: .top).clipped()
                            HStack {
                                Button("打开计划") { reader = plan }.frame(minHeight: 44)
                                if state.review?.planId == plan.planId, state.review?.planRevision == plan.revision,
                                   state.review?.status == "open" || (state.review?.status == "approved" && state.execution?.status == "rejected" && state.execution?.retryable == true) {
                                    Button(state.review?.status == "approved" ? "重试启动" : "审阅计划", action: chat.openPlanReview).frame(minHeight: 44)
                                        .disabled(!chat.session.runtime.allows("session.plan_review") || state.freshness != "fresh" || state.capabilities?.actions.isEmpty != false)
                                }
                            }
                        }
                    }.padding(16).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
                }
            }.sheet(item: $reader) { plan in
                SessionPlanReader(plan: plan, offset: Binding(get: { positions[plan.id] ?? 0 }, set: { positions[plan.id] = $0 }))
            }
        }
    }
}

private struct PlanWritingTitle: View {
    let writing: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var visible = false
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 15, paused: !writing || !visible || reduceMotion || scenePhase != .active)) { context in
            Text(writing ? "正在撰写计划" : "计划草稿已中断").font(.headline)
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
    @AccessibilityFocusState private var titleFocused: Bool
    private func allowed(_ action: String) -> Bool {
        target.freshness == "fresh" && !target.epoch.isEmpty && target.capabilities?.actions.contains(action) == true && !chat.isWorking
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("是否执行这个计划？").font(.headline).accessibilityAddTraits(.isHeader).accessibilityFocused($titleFocused)
                Text("\(target.proposal?.title ?? "计划") · 版本 \(target.proposal?.revision ?? 1)").font(.caption).foregroundStyle(.secondary)
                if target.freshness != "fresh" { Text("原生状态待核对，请刷新后再确认。").font(.caption) }
                if target.review?.status == "open" {
                    TextField("修改意见：不，说明需要如何调整计划", text: $feedback, axis: .vertical).lineLimit(2...3).textFieldStyle(.roundedBorder).disabled(!allowed("request_revision"))
                }
                if let error = chat.error { Text(error).foregroundStyle(.red) }
                HStack {
                    Button(chat.isWorking ? "正在确认…" : target.review?.status == "approved" ? "重试启动" : "同意并执行") { respond("approve_and_execute") }
                        .frame(minHeight: 44).buttonStyle(.borderedProminent).disabled(!allowed("approve_and_execute"))
                    if target.review?.status == "open" {
                        Button("暂不执行") { respond("dismiss_review") }.frame(minHeight: 44).disabled(!allowed("dismiss_review"))
                    }
                }
                if target.review?.status == "open" {
                    Button("提交修改意见") { respond("request_revision") }.frame(minHeight: 44)
                        .disabled(!allowed("request_revision") || feedback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }.padding(16)
        }.frame(maxHeight: 300).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20)).padding(.horizontal, 12).padding(.vertical, 8)
            .onChange(of: chat.planReviewFocusRequest) { titleFocused = true }
    }
    private func respond(_ action: String) { Task { await chat.respondPlan(target, action: action, feedback: action == "request_revision" ? feedback.trimmingCharacters(in: .whitespacesAndNewlines) : "") } }
}
