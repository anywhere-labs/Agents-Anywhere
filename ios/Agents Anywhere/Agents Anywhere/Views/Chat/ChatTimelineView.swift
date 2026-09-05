import SwiftUI

struct ChatTimelineView: View {
    let model: SessionChatModel
    let onAttachment: (V2AttachmentContent) -> Void
    @State private var historyAnchor: String?
    @State private var followsTail = true
    @State private var userIsScrolling = false
    @State private var viewport = TimelineViewport()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .caption) private var returnPillHeight: CGFloat = 32

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // The repository loads bounded history pages. Measured row heights
                // keep a streaming tail stable while the current page changes.
                VStack(alignment: .leading, spacing: 24) {
                    if model.session.hasOlderItems {
                        Button("加载较早的消息") {
                            followsTail = false
                            historyAnchor = model.timeline.rows.first?.id
                            Task { await model.session.loadOlder() }
                        }
                        .font(.footnote)
                        .disabled(model.session.isLoadingHistory)
                        .frame(maxWidth: .infinity)
                    }
                    ForEach(model.timeline.rows) { row in
                        SessionTimelineRow(row: row, onAttachment: onAttachment).id(row.id)
                    }
                    ForEach(model.session.pendingMessages) { pending in
                        PendingMessageRow(pending: pending, onDismiss: {
                            model.session.dismissPendingMessage(id: pending.id)
                        })
                    }
                    if model.isRunning && !model.timeline.rows.contains(where: { $0.value.isStreamingText }) {
                        Text("正在处理任务").font(.subheadline).foregroundStyle(.secondary)
                            .frame(height: 40, alignment: .leading)
                    }
                    if model.session.hasNewerItems {
                        Button("加载最新消息") {
                            followsTail = true
                            Task { await model.session.loadLatest() }
                        }
                        .frame(maxWidth: .infinity)
                    }
                    Color.clear.frame(height: 1).padding(.bottom, 12).id("tail")
                }
                .padding(.horizontal, 24)
                .padding(.top, 20)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollIndicators(.hidden)
            .defaultScrollAnchor(.top, for: .initialOffset)
            .defaultScrollAnchor(.top, for: .alignment)
            .defaultScrollAnchor(.top, for: .sizeChanges)
            .onScrollPhaseChange { _, phase in
                let wasUserScrolling = userIsScrolling
                userIsScrolling = phase == .tracking || phase == .interacting || phase == .decelerating
                if wasUserScrolling, !userIsScrolling { followsTail = viewport.isNearBottom }
            }
            .onScrollGeometryChange(for: TimelineViewport.self) { geometry in
                TimelineViewport(contentHeight: geometry.contentSize.height, containerHeight: geometry.containerSize.height,
                                 topInset: geometry.contentInsets.top, bottomInset: geometry.contentInsets.bottom,
                                 offsetY: geometry.contentOffset.y)
            } action: { _, value in
                viewport = value
                if userIsScrolling { followsTail = value.isNearBottom }
            }
            .onChange(of: model.session.pendingMessages.last?.id) { _, id in
                if id != nil { followsTail = true }
            }
            .onChange(of: model.timeline.rows.map(\.id)) {
                if let anchor = historyAnchor {
                    proxy.scrollTo(anchor, anchor: .top)
                    historyAnchor = nil
                }
            }
            .task(id: FollowRequest(conversation: model.session.id,
                                    contentHeight: viewport.contentHeight, visibleHeight: viewport.visibleHeight,
                                    followsTail: followsTail,
                                    userIsScrolling: userIsScrolling)) {
                guard viewport.shouldFollowTail(isFollowing: followsTail, userIsScrolling: userIsScrolling) else { return }
                // Coalesce measured size changes, including the first keyboard
                // dismissal and asynchronous Markdown layout. Scrolling changes
                // offsets, which intentionally are NOT part of this task's ID.
                do { try await Task.sleep(for: .milliseconds(24)) } catch { return }
                guard !Task.isCancelled,
                      viewport.shouldFollowTail(isFollowing: followsTail, userIsScrolling: userIsScrolling) else { return }
                // Retarget the same critically damped spring as lines arrive.
                // This transaction changes only the scroll destination; Markdown
                // measurements and token flushes keep their own transactions.
                var transaction = Transaction(animation: followAnimation)
                transaction.isContinuous = true
                withTransaction(transaction) { proxy.scrollTo("tail", anchor: .bottom) }
            }
            .overlay(alignment: .bottom) {
                if !followsTail && viewport.hasOverflow {
                    Button {
                        followsTail = true
                        withAnimation(followAnimation) { proxy.scrollTo("tail", anchor: .bottom) }
                    } label: {
                        Label("到底部", systemImage: "arrow.down")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.primary)
                            .padding(.horizontal, 12)
                            .frame(height: returnPillHeight)
                            .glassEffect(.regular.interactive(), in: .capsule)
                            // Keep a 44 pt touch target around the smaller pill.
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("回到最新消息")
                    .accessibilityIdentifier("chat.timeline.bottom")
                    .padding(.bottom, 2)
                }
            }
        }
    }

    private var followAnimation: Animation? {
        reduceMotion ? nil : .interactiveSpring(response: 0.28, dampingFraction: 1, blendDuration: 0.12)
    }
}

private struct FollowRequest: Equatable {
    let conversation: String
    let contentHeight: CGFloat
    let visibleHeight: CGFloat
    let followsTail: Bool
    let userIsScrolling: Bool
}
