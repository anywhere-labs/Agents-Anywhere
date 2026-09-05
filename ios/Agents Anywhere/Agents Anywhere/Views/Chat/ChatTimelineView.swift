import SwiftUI

struct ChatTimelineView: View {
    let model: SessionChatModel
    let onAttachment: (V2AttachmentContent) -> Void
    let onFile: (String) -> Void
    @State private var historyAnchor: String?
    @State private var position = ScrollPosition(idType: String.self)
    @State private var scrolling = TimelineScrollState()
    @State private var viewport = TimelineViewport()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .caption) private var returnPillHeight: CGFloat = 32

    private var groups: [ChatTimelineGroup] {
        TimelineGrouping.groups(model.timeline.rows, interactionTargets: Set(model.session.notices.notices
            .filter(\.isVisible).compactMap(\.timelineTargetID)))
    }
    var body: some View {
        // A sibling overlay receives taps independently of the scroll view's
        // deceleration recognizer. The explicit return intent survives its callbacks.
        ZStack(alignment: .bottom) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if model.session.hasOlderItems {
                        Button("加载较早的消息") {
                            scrolling.browseHistory()
                            historyAnchor = groups.first?.id
                            Task { await model.session.loadOlder() }
                        }.font(.footnote).disabled(model.session.isLoadingHistory).frame(maxWidth: .infinity)
                    }
                    ForEach(groups) { group in
                        SessionTimelineGroupView(group: group, chat: model, onAttachment: onAttachment, onFile: onFile)
                            .id(group.id)
                    }
                    ForEach(model.session.notices.notices.filter { notice in
                        notice.isVisible && !notice.blocks(model.session.id)
                            && !model.timeline.rows.contains(where: { $0.id == notice.timelineTargetID })
                    }) { item in SessionInteractionCard(item: item, chat: model) }
                    ForEach(model.timeline.pendingMessages) { pending in
                        PendingMessageRow(pending: pending, onDismiss: { model.session.dismissPendingMessage(id: pending.id) })
                    }
                    if model.isRunning && !model.timeline.rows.contains(where: { $0.value.isStreamingText }) {
                        Text("正在处理任务").font(.subheadline).foregroundStyle(.secondary).frame(height: 40, alignment: .leading)
                    }
                    if model.session.hasNewerItems {
                        Button("加载最新消息") {
                            scrolling.requestBottom()
                            Task { await model.session.loadLatest() }
                        }.frame(maxWidth: .infinity)
                    }
                    Color.clear.frame(height: 1).padding(.bottom, 12).id("tail")
                }
                .scrollTargetLayout()
                .padding(.horizontal, 24).padding(.top, 16)
                .frame(maxWidth: 760).frame(maxWidth: .infinity)
            }
            .scrollPosition($position)
            .scrollDismissesKeyboard(.interactively)
            .scrollIndicators(.hidden)
            .scrollEdgeEffectStyle(.soft, for: .top)
            .defaultScrollAnchor(.top, for: .initialOffset)
            .defaultScrollAnchor(.top, for: .alignment)
            .defaultScrollAnchor(.top, for: .sizeChanges)
            .onScrollPhaseChange { _, phase in
                let mapped: TimelineScrollState.Phase
                switch phase {
                case .idle: mapped = .idle
                case .tracking: mapped = .tracking
                case .interacting: mapped = .interacting
                case .decelerating: mapped = .decelerating
                case .animating: mapped = .animating
                @unknown default: mapped = .idle
                }
                scrolling.phaseChanged(mapped, viewport: viewport)
            }
            .onScrollGeometryChange(for: TimelineViewport.self) { geometry in
                TimelineViewport(contentHeight: geometry.contentSize.height, containerHeight: geometry.containerSize.height,
                    topInset: geometry.contentInsets.top, bottomInset: geometry.contentInsets.bottom, offsetY: geometry.contentOffset.y)
            } action: { _, value in viewport = value; scrolling.geometryChanged(value) }
            .onChange(of: model.session.pendingMessages.last?.id) { _, id in
                if id != nil { scrolling.requestBottom() }
            }
            .onChange(of: model.timeline.rows.map(\.id)) {
                if let anchor = historyAnchor, groups.first?.id != anchor,
                   let group = groups.first(where: { $0.rows.contains(where: { $0.id == anchor }) }) {
                    position.scrollTo(id: group.id, anchor: .top); historyAnchor = nil
                }
            }
            .task(id: FollowRequest(contentHeight: viewport.contentHeight, visibleHeight: viewport.visibleHeight,
                followsTail: scrolling.followsTail, userIsScrolling: scrolling.userIsScrolling,
                returnGeneration: scrolling.returnGeneration)) {
                guard scrolling.shouldFollow(viewport) else { return }
                do { try await Task.sleep(for: .milliseconds(24)) } catch { return }
                guard !Task.isCancelled, scrolling.shouldFollow(viewport) else { return }
                scrollToBottom()
            }
            if !scrolling.followsTail && viewport.hasOverflow {
                Button {
                    scrolling.requestBottom()
                    scrollToBottom()
                } label: {
                    Label("到底部", systemImage: "arrow.down").font(.caption.weight(.medium)).foregroundStyle(.primary)
                        .padding(.horizontal, 12).frame(height: returnPillHeight)
                        .glassEffect(.regular.interactive(), in: .capsule)
                        .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityIdentifier("chat.timeline.bottom")
                .padding(.bottom, 2)
            }
        }
    }
    private func scrollToBottom() {
        var transaction = Transaction(animation: reduceMotion ? nil : .interactiveSpring(response: 0.28, dampingFraction: 1, blendDuration: 0.12))
        transaction.isContinuous = true
        withTransaction(transaction) { position.scrollTo(edge: .bottom) }
    }
    private struct FollowRequest: Equatable {
        let contentHeight: CGFloat
        let visibleHeight: CGFloat
        let followsTail: Bool
        let userIsScrolling: Bool
        let returnGeneration: Int
    }
}
