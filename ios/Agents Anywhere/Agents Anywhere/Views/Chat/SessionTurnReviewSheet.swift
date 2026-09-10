import SwiftUI

/// Mounted only for completed turns. Observing file-change payloads here keeps
/// token appends out of the timeline's structural grouping and earlier footers.
struct SessionTurnReviewFooter: View {
    let action: TimelineTurnAction
    let root: String?
    let hasOlderItems: Bool
    let onFile: (String) -> Void
    @State private var showsReview = false
    @State private var pendingFile: String?

    var body: some View {
        if !action.changes.isEmpty {
            let windows = root?.range(of: #"^[A-Za-z]:[/\\]|^\\\\"#, options: .regularExpression) != nil
            let review = TimelineTurnReview.build(items: action.changes.map(\.value), root: root, caseInsensitive: windows)
            if !review.files.isEmpty {
                Button { showsReview = true } label: {
                    HStack(spacing: 6) {
                        AppSymbol("doc.text", size: 14)
                        Text(String(localized: "\(review.files.count) 个文件"))
                        Text("·")
                        Text("+\(review.additions)").foregroundStyle(.green)
                        Text("−\(review.deletions)").foregroundStyle(.red)
                        AppSymbol("chevron.right", size: 10)
                    }
                    .font(.footnote).monospacedDigit().lineLimit(1)
                    .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(.secondary)
                .accessibilityHint(String(localized: "查看本轮文件和 diff"))
                .accessibilityIdentifier("chat.turn.review")
                .sheet(isPresented: $showsReview, onDismiss: {
                    if let path = pendingFile { pendingFile = nil; onFile(path) }
                }) {
                    SessionTurnReviewSheet(review: review, isPartial: hasOlderItems && action.startsMidTurn) { path in
                        pendingFile = path; showsReview = false
                    }
                }
            }
        }
    }
}

private struct SessionTurnReviewSheet: View {
    let review: TimelineTurnReview
    let isPartial: Bool
    let onFile: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var expanded: Set<String> = []

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if isPartial {
                        Text(String(localized: "此轮较早的记录尚未载入，当前显示已加载的文件变更。"))
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    Text(String(localized: "统计来自本轮记录的 diff；同一文件的多次修改按顺序保留。"))
                        .font(.footnote).foregroundStyle(.secondary)
                    ForEach(review.files) { file in
                        VStack(alignment: .leading, spacing: 0) {
                            Button {
                                if !expanded.insert(file.id).inserted { expanded.remove(file.id) }
                            } label: {
                                HStack(spacing: 8) {
                                    AppSymbol(expanded.contains(file.id) ? "chevron.down" : "chevron.right", size: 10)
                                    Text(file.displayPath).font(.system(.subheadline, design: .monospaced))
                                        .lineLimit(2).truncationMode(.middle).frame(maxWidth: .infinity, alignment: .leading)
                                    Text("+\(file.additions)").foregroundStyle(.green)
                                    Text("−\(file.deletions)").foregroundStyle(.red)
                                }.font(.caption).monospacedDigit().padding(12).frame(minHeight: 44).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                            if expanded.contains(file.id) {
                                HStack {
                                    Text(file.action.label).font(.caption).foregroundStyle(.secondary)
                                    Spacer()
                                    Button(String(localized: "打开文件预览"), systemImage: "arrow.up.right") { onFile(file.path) }
                                        .disabled(file.action == .delete)
                                }.font(.caption).padding(.horizontal, 12).frame(minHeight: 44)
                                if file.patches.isEmpty {
                                    Text(String(localized: "这条文件变更记录未提供 diff。"))
                                        .font(.footnote).foregroundStyle(.secondary).padding(12)
                                }
                                ForEach(file.patches) { patch in
                                    TimelineCodePanel(label: patch.isDiff ? "diff" : "code", code: patch.text, isDiff: patch.isDiff)
                                }
                            }
                        }
                        .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 14))
                        .clipShape(.rect(cornerRadius: 14))
                    }
                }.padding(16)
            }
            .navigationTitle(String(localized: "本轮文件变更"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetCloseToolbar { dismiss() } }
        }
        .appSheetPresentation(.expanded)
    }
}
