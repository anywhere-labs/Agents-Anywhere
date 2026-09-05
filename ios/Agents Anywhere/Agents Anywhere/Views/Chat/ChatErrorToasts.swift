import SwiftUI

/// Non-inline errors float below the header. Paging only changes the visible
/// toast; retry is always an explicit read, never a replay of the failed action.
struct ChatErrorToasts: View {
    let store: ChatToastStore
    let isRetrying: Bool
    let onRetry: (String) async -> Void
    @State private var selected: String?
    @ScaledMetric(relativeTo: .footnote) private var lineHeight: CGFloat = 18
    private var height: CGFloat { min(220, max(136, lineHeight * 4 + 74)) }

    var body: some View {
        if !store.items.isEmpty {
            ScrollView(.horizontal) {
                HStack(spacing: 12) {
                    ForEach(Array(store.items.enumerated()), id: \.element.id) { index, item in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 8) {
                                Image(systemName: "exclamationmark.circle").foregroundStyle(.secondary)
                                Text(item.title).font(.subheadline.weight(.medium)).lineLimit(1)
                                Spacer(minLength: 0)
                                if store.items.count > 1 {
                                    Text("\(index + 1)/\(store.items.count)").font(.caption2).monospacedDigit().foregroundStyle(.secondary)
                                }
                                Button { store.dismiss(item.id) } label: {
                                    Image(systemName: "xmark").font(.system(size: 11, weight: .medium)).frame(width: 44, height: 44)
                                }.buttonStyle(.plain).accessibilityLabel("关闭此提示")
                            }
                            ScrollView(.vertical) {
                                Text(item.message).font(.footnote).foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                            }.scrollBounceBehavior(.basedOnSize)
                            if item.canRetry {
                                Button(isRetrying ? "正在刷新…" : "刷新状态") { Task { await onRetry(item.id) } }
                                    .font(.footnote.weight(.medium)).frame(minHeight: 36).disabled(isRetrying)
                            }
                        }
                        .padding(.leading, 16).padding(.trailing, 4).padding(.bottom, 12)
                        .frame(height: height)
                        .containerRelativeFrame(.horizontal)
                        .glassEffect(.regular, in: .rect(cornerRadius: 24))
                        .id(item.id)
                    }
                }.scrollTargetLayout()
            }
            .scrollIndicators(.hidden).scrollTargetBehavior(.viewAligned)
            .scrollPosition(id: $selected).scrollClipDisabled()
            .frame(height: height)
            .padding(.horizontal, ChatControlMetrics.collapsedHorizontalInset)
            .padding(.top, 4).padding(.bottom, 10)
            .frame(maxWidth: ChatControlMetrics.maximumContentWidth)
            .onChange(of: store.items.map(\.id), initial: true) { _, ids in
                if selected == nil || !ids.contains(selected ?? "") { selected = ids.first }
            }
            .accessibilityHint(store.items.count > 1 ? "左右滑动查看其他提示" : "")
        }
    }
}
