import SwiftUI

struct ChatTimelineView: View {
    let model: SessionChatModel
    let onAttachment: (V2AttachmentContent) -> Void
    let onFile: (String) -> Void
    @State private var historyAnchor: String?
    @State private var position = ScrollPosition(idType: String.self)
    @State private var scrolling = TimelineScrollState()
    @State private var viewport = TimelineViewport()
    @State private var latestPull = TimelineLatestPull()
    @State private var latestPromptVisible = false
    @State private var latestLoadRequest: Int?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .caption) private var returnPillHeight: CGFloat = 32

    private var hasInteractions: Bool {
        model.session.notices.notices.contains { $0.isVisible && $0.notice.type == "interaction" }
    }
    var body: some View {
        // A sibling overlay receives taps independently of the scroll view's
        // deceleration recognizer. The explicit return intent survives its callbacks.
        ZStack(alignment: .bottom) {
            ScrollView {
                ChatTimelineContent(model: model, onAttachment: onAttachment, onFile: onFile,
                    latestPullReady: latestPull.isReady, isLoadingLatest: latestLoadRequest != nil,
                    onLoadOlder: {
                        scrolling.browseHistory()
                        historyAnchor = model.timeline.rows.first?.id
                        Task { await model.session.loadOlder() }
                    }, onLoadLatest: loadLatest, onPromptVisibility: { latestPromptVisible = $0 })
                    .equatable()
            }
            .scrollPosition($position)
            .scrollDismissesKeyboard(.interactively)
            .scrollIndicators(.hidden)
            .scrollBounceBehavior(.always, axes: .vertical)
            .scrollEdgeEffectStyle(.soft, for: .top)
            .defaultScrollAnchor(.top, for: .initialOffset)
            .defaultScrollAnchor(.top, for: .alignment)
            .defaultScrollAnchor(.top, for: .sizeChanges)
            .onScrollPhaseChange { _, phase, context in
                let mapped: TimelineScrollState.Phase
                switch phase {
                case .idle: mapped = .idle
                case .tracking: mapped = .tracking
                case .interacting: mapped = .interacting
                case .decelerating: mapped = .decelerating
                case .animating: mapped = .animating
                @unknown default: mapped = .idle
                }
                let current = TimelineViewport(geometry: context.geometry)
                let wasInteracting = scrolling.phase == .interacting
                viewport = current
                if scrolling.phaseChanged(mapped, viewport: current) {
                    // Release ScrollPosition's persistent edge target as soon
                    // as the user takes over, including interrupted animations.
                    position.isPositionedByUser = true
                    latestPull.begin(at: current, promptVisible: latestPromptVisible,
                        canLoad: model.session.hasNewerItems && !model.session.isLoadingHistory && latestLoadRequest == nil)
                }
                if mapped == .interacting { latestPull.update(current) }
                if mapped == .idle || mapped == .decelerating {
                    let shouldLoad = latestPull.end()
                    if wasInteracting && shouldLoad { loadLatest() }
                } else if mapped == .animating { latestPull.cancel() }
            }
            .onScrollGeometryChange(for: TimelineViewport.self) { geometry in
                TimelineViewport(geometry: geometry)
            } action: { _, value in
                viewport = value
                scrolling.geometryChanged(value)
                if scrolling.phase == .interacting { latestPull.update(value) }
            }
            .onChange(of: model.session.pendingMessages.last?.id) { _, id in
                if id != nil && !hasInteractions { scrolling.requestBottom() }
            }
            .onChange(of: hasInteractions, initial: true) { _, presented in
                scrolling.setInteractionPresented(presented)
                if presented || !scrolling.followsTail { position.isPositionedByUser = true }
            }
            .onChange(of: scrolling.returningToBottom) { _, returning in
                if !returning && hasInteractions { position.isPositionedByUser = true }
            }
            .onChange(of: model.timeline.rows.map(\.id)) {
                if let anchor = historyAnchor, model.timeline.rows.first?.id != anchor {
                    let targets = Set(model.session.notices.notices.filter(\.isVisible).compactMap(\.timelineTargetID))
                    if let group = TimelineGrouping.groups(model.timeline.rows, interactionTargets: targets)
                        .first(where: { $0.rows.contains(where: { $0.id == anchor }) }) {
                        position.scrollTo(id: group.id, anchor: .top)
                    }
                    historyAnchor = nil
                }
            }
            .task(id: FollowRequest(contentHeight: viewport.contentHeight, visibleHeight: viewport.visibleHeight,
                followsTail: scrolling.followsTail, userIsScrolling: scrolling.userIsScrolling,
                navigationGeneration: scrolling.navigationGeneration, interactionIsPresented: hasInteractions)) {
                guard (!hasInteractions || scrolling.returningToBottom), scrolling.shouldFollow(viewport) else { return }
                do { try await Task.sleep(for: .milliseconds(24)) } catch { return }
                guard !Task.isCancelled, (!hasInteractions || scrolling.returningToBottom), scrolling.shouldFollow(viewport) else { return }
                scrollToBottom()
            }
            .task(id: latestLoadRequest) {
                guard let generation = latestLoadRequest else { return }
                await model.session.loadLatest()
                guard !Task.isCancelled else { return }
                // A drag during the fetch must not be undone when it finishes.
                if scrolling.navigationGeneration == generation { scrolling.requestBottom() }
                latestLoadRequest = nil
            }
            if scrolling.showsBottomButton(viewport) {
                Button {
                    latestPull.cancel()
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
    private func loadLatest() {
        guard model.session.isValid, model.session.hasNewerItems,
              !model.session.isLoadingHistory, latestLoadRequest == nil else { return }
        historyAnchor = nil
        scrolling.requestBottom()
        latestLoadRequest = scrolling.navigationGeneration
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
        let navigationGeneration: Int
        let interactionIsPresented: Bool
    }
}

private struct ChatTimelineContent: View, Equatable {
    let model: SessionChatModel
    let onAttachment: (V2AttachmentContent) -> Void
    let onFile: (String) -> Void
    let latestPullReady: Bool
    let isLoadingLatest: Bool
    let onLoadOlder: () -> Void
    let onLoadLatest: () -> Void
    let onPromptVisibility: (Bool) -> Void

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.model === rhs.model && lhs.latestPullReady == rhs.latestPullReady && lhs.isLoadingLatest == rhs.isLoadingLatest
    }
    var body: some View {
        let groups = TimelineGrouping.groups(model.timeline.rows, interactionTargets: Set(model.session.notices.notices
            .filter(\.isVisible).compactMap(\.timelineTargetID)))
        let actions = TimelineTurnActions.build(groups: groups, suppressLatest: model.isRunning || model.session.hasNewerItems)
        LazyVStack(alignment: .leading, spacing: 20) {
            if model.session.hasOlderItems {
                Button("加载较早的消息", action: onLoadOlder).font(.footnote).disabled(model.session.isLoadingHistory).frame(maxWidth: .infinity)
            }
            ForEach(groups) { group in
                SessionTimelineGroupView(group: group, chat: model, onAttachment: onAttachment, onFile: onFile,
                    turnAction: actions[group.id])
                    .id(group.id)
            }
            ForEach(model.session.notices.notices.filter { notice in
                notice.isVisible && !notice.blocks(model.session.id)
                    && !model.timeline.rows.contains(where: { $0.id == notice.timelineTargetID })
            }) { item in SessionInteractionCard(item: item, chat: model) }
            ForEach(model.timeline.pendingMessages) { pending in
                PendingMessageRow(pending: pending, onDismiss: { model.session.dismissPendingMessage(id: pending.id) })
            }
            if model.isRunning && !model.timeline.rows.contains(where: { $0.structure.isStreamingText }) {
                Text("正在处理任务").font(.subheadline).foregroundStyle(.secondary).frame(height: 40, alignment: .leading)
            }
            if model.session.hasNewerItems {
                Button(action: onLoadLatest) {
                    Group {
                        if isLoadingLatest { ProgressView("正在加载更新的记录…") }
                        else { Text(latestPullReady ? "松开加载更新的记录" : "继续上拉加载更新的记录") }
                    }.font(.footnote).frame(maxWidth: .infinity, minHeight: 44)
                }
                .disabled(model.session.isLoadingHistory || isLoadingLatest)
                .onScrollVisibilityChange { onPromptVisibility($0) }
            }
            // Constant breathing room: status text and card counts cannot
            // change this spacer or create a spurious follow request.
            Color.clear.frame(height: 32).id("tail")
        }
        .scrollTargetLayout()
        .padding(.horizontal, 24).padding(.top, 16)
        .frame(maxWidth: 760).frame(maxWidth: .infinity)
    }
}

private extension TimelineViewport {
    init(geometry: ScrollGeometry) {
        self.init(contentHeight: geometry.contentSize.height, containerHeight: geometry.containerSize.height,
            topInset: geometry.contentInsets.top, bottomInset: geometry.contentInsets.bottom, offsetY: geometry.contentOffset.y)
    }
}
