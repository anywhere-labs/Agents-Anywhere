import SwiftUI

struct ChatTimelineView: View {
    let model: SessionChatModel
    @Binding var isInitialPositioned: Bool
    @Binding var openingPositionFailed: Bool
    let openingAttempt: Int
    let onAttachment: (V2AttachmentContent) -> Void
    let onFile: (String) -> Void
    @State private var historyLayout: TimelineHistoryLayout?
    @State private var historyPosition: TimelineHistoryPosition?
    @State private var hasRequestedOlder = false
    @State private var position = ScrollPosition(idType: String.self)
    @State private var scrolling = TimelineScrollState()
    @State private var viewport = TimelineViewport()
    @State private var latestPull = TimelineHistoryPull()
    @State private var olderPull = TimelineHistoryPull(edge: .older)
    @State private var olderPromptVisible = false
    @State private var olderLoadRequest: Int?
    @State private var latestPromptVisible = false
    @State private var latestLoadRequest: Int?
    @State private var nativePhase = TimelineScrollState.Phase.idle
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.sidebarDrawerIsTransitioning) private var sidebarIsTransitioning
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
                    olderPullReady: olderPull.isReady, isLoadingOlder: olderLoadRequest != nil,
                    keepsOlderPrompt: hasRequestedOlder, historyAnchor: historyPosition?.origin,
                    onLoadOlder: loadOlder, onLoadLatest: loadLatest,
                    onHistoryLayout: historyDidLayOut,
                    onPromptVisibility: { latestPromptVisible = $0 },
                    onOlderPromptVisibility: { olderPromptVisible = $0 },
                    onTailVisibility: { region, visible in scrolling.tailVisibilityChanged(region, visible: visible) })
                    .equatable()
            }
            .scrollPosition($position)
            .scrollDismissesKeyboard(.interactively)
            .scrollIndicators(.hidden)
            .scrollBounceBehavior(.always, axes: .vertical)
            .scrollEdgeEffectStyle(.soft, for: .top)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(.top, for: .alignment)
            .defaultScrollAnchor(.top, for: .sizeChanges)
            .allowsHitTesting(isInitialPositioned)
            .accessibilityHidden(!isInitialPositioned)
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
                nativePhase = mapped
                // The drawer owns horizontal navigation. Do not interpret its
                // interrupted scroll callbacks as a fresh vertical reading intent.
                if sidebarIsTransitioning { return }
                if scrolling.phaseChanged(mapped) {
                    // Release ScrollPosition's persistent edge target as soon
                    // as the user takes over, including interrupted animations.
                    position.isPositionedByUser = true
                    historyPosition?.cancelRestoration()
                    olderPull.begin(at: current, promptVisible: olderPromptVisible,
                        canLoad: model.session.hasOlderItems && !model.session.isLoadingHistory && olderLoadRequest == nil && latestLoadRequest == nil)
                    latestPull.begin(at: current, promptVisible: latestPromptVisible,
                        canLoad: model.session.hasNewerItems && !model.session.isLoadingHistory && latestLoadRequest == nil && olderLoadRequest == nil)
                }
                if mapped == .interacting { latestPull.update(current); olderPull.update(current) }
                if mapped == .idle || mapped == .decelerating {
                    let shouldLoadLatest = latestPull.end(), shouldLoadOlder = olderPull.end()
                    if wasInteracting {
                        if shouldLoadOlder { loadOlder() }
                        else if shouldLoadLatest { loadLatest() }
                    }
                } else if mapped == .animating { latestPull.cancel(); olderPull.cancel() }
            }
            .onScrollGeometryChange(for: TimelineViewport.self) { geometry in
                TimelineViewport(geometry: geometry)
            } action: { _, value in
                viewport = value
                if !sidebarIsTransitioning && scrolling.phase == .interacting { latestPull.update(value); olderPull.update(value) }
            }
            .onChange(of: sidebarIsTransitioning) { _, transitioning in
                if transitioning {
                    if isInitialPositioned { position.isPositionedByUser = true }
                    latestPull.cancel(); olderPull.cancel()
                } else {
                    scrolling.phaseChanged(nativePhase)
                    if let historyLayout { historyDidLayOut(historyLayout) }
                }
            }
            .onChange(of: model.session.pendingMessages.last?.id) { _, id in
                if isInitialPositioned, id != nil && !hasInteractions { scrolling.requestBottom() }
            }
            .onChange(of: model.responseRevision) { _, _ in
                if isInitialPositioned { scrolling.requestBottom() }
            }
            .onChange(of: hasInteractions, initial: true) { _, presented in
                scrolling.setInteractionPresented(presented)
                if isInitialPositioned && (presented || !scrolling.followsTail) { position.isPositionedByUser = true }
            }
            .onChange(of: scrolling.returningToBottom) { _, returning in
                if isInitialPositioned && !returning && hasInteractions { position.isPositionedByUser = true }
            }
            .task(id: OpeningRequest(ready: model.isOpeningReady, completed: isInitialPositioned, attempt: openingAttempt)) {
                guard model.isOpeningReady, !isInitialPositioned else { return }
                openingPositionFailed = false
                model.timeline.holdForOpening()
                scrolling.requestBottom()
                var opening = TimelineOpeningPosition(now: ProcessInfo.processInfo.systemUptime)
                while !Task.isCancelled {
                    switch opening.advance(viewport: viewport, isAtBottom: scrolling.tail.isAtBottom,
                        isIdle: scrolling.phase == .idle && !sidebarIsTransitioning, now: ProcessInfo.processInfo.systemUptime) {
                    case .wait: break
                    case .scrollToBottom:
                        var transaction = Transaction(animation: nil)
                        transaction.disablesAnimations = true
                        withTransaction(transaction) { position.scrollTo(edge: .bottom) }
                    case .reveal:
                        if hasInteractions { position.isPositionedByUser = true }
                        isInitialPositioned = true
                        model.timeline.finishOpening()
                        return
                    case .retry:
                        openingPositionFailed = true
                        return
                    }
                    do { try await Task.sleep(for: .milliseconds(32)) } catch { return }
                }
            }
            .task(id: FollowRequest(contentHeight: viewport.contentHeight, visibleHeight: viewport.visibleHeight,
                followsTail: scrolling.followsTail, userIsScrolling: scrolling.userIsScrolling,
                navigationGeneration: scrolling.navigationGeneration, interactionIsPresented: hasInteractions,
                sidebarIsTransitioning: sidebarIsTransitioning, tail: scrolling.tail)) {
                guard isInitialPositioned, !sidebarIsTransitioning, (!hasInteractions || scrolling.returningToBottom), scrolling.shouldFollow() else { return }
                do { try await Task.sleep(for: .milliseconds(24)) } catch { return }
                guard !Task.isCancelled, isInitialPositioned, !sidebarIsTransitioning, (!hasInteractions || scrolling.returningToBottom), scrolling.shouldFollow() else { return }
                scrollToBottom()
            }
            .task(id: ScrollSettlement(phase: scrolling.phase, tail: scrolling.tail, generation: scrolling.navigationGeneration)) {
                guard scrolling.needsScrollSettlement else { return }
                do { try await Task.sleep(for: .milliseconds(64)) } catch { return }
                guard !Task.isCancelled else { return }
                scrolling.settleUserScroll()
            }
            .task(id: olderLoadRequest) {
                guard let request = olderLoadRequest else { return }
                await model.session.loadOlder()
                guard !Task.isCancelled, historyPosition?.id == request else { return }
                if !model.session.isValid { historyPosition = nil; olderLoadRequest = nil; return }
                historyPosition?.receivedPage(firstRowID: model.session.timeline.first { $0.value.isVisibleInChat }?.id)
            }
            .task(id: HistorySettlement(id: historyPosition?.id, ready: historyPosition?.isReadyToFinish == true,
                offset: historyPosition?.restoredOffset)) {
                guard let request = historyPosition?.id, historyPosition?.isReadyToFinish == true else { return }
                // Let the point correction reach native layout before releasing
                // its target or ending the spinner. A new measurement restarts this.
                do { try await Task.sleep(for: .milliseconds(64)) } catch { return }
                guard !Task.isCancelled, historyPosition?.id == request else { return }
                if scrolling.navigationGeneration == request, historyPosition?.restoredOffset != nil {
                    position.isPositionedByUser = true
                }
                historyPosition = nil; olderLoadRequest = nil
            }
            .task(id: latestLoadRequest) {
                guard let generation = latestLoadRequest else { return }
                await model.session.loadLatest()
                guard !Task.isCancelled else { return }
                // A drag during the fetch must not be undone when it finishes.
                if scrolling.navigationGeneration == generation { scrolling.requestBottom() }
                latestLoadRequest = nil
            }
            if isInitialPositioned && scrolling.showsBottomButton() {
                Button {
                    latestPull.cancel(); olderPull.cancel()
                    historyPosition?.cancelRestoration()
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
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private func loadOlder() {
        guard model.session.isValid, model.session.hasOlderItems,
              !model.session.isLoadingHistory, olderLoadRequest == nil, latestLoadRequest == nil else { return }
        olderPull.cancel(); latestPull.cancel()
        scrolling.browseHistory()
        position.isPositionedByUser = true
        let layout = historyLayout.flatMap { $0.firstRowID == model.timeline.rows.first?.id ? $0 : nil }
        historyPosition = TimelineHistoryPosition(id: scrolling.navigationGeneration, layout: layout,
            offsetY: viewport.offsetY, topInset: viewport.topInset)
        hasRequestedOlder = true
        olderLoadRequest = scrolling.navigationGeneration
    }
    private func loadLatest() {
        guard model.session.isValid, model.session.hasNewerItems,
              !model.session.isLoadingHistory, latestLoadRequest == nil, olderLoadRequest == nil else { return }
        olderPull.cancel(); latestPull.cancel()
        historyPosition?.cancelRestoration()
        scrolling.requestBottom()
        latestLoadRequest = scrolling.navigationGeneration
    }
    private func scrollToBottom() {
        var transaction = Transaction(animation: reduceMotion ? nil : .interactiveSpring(response: 0.28, dampingFraction: 1, blendDuration: 0.12))
        transaction.isContinuous = true
        withTransaction(transaction) { position.scrollTo(edge: .bottom) }
    }
    private func historyDidLayOut(_ layout: TimelineHistoryLayout) {
        historyLayout = layout
        guard !sidebarIsTransitioning else { return }
        guard let offset = historyPosition?.laidOut(layout, generation: scrolling.navigationGeneration) else { return }
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) { position.scrollTo(y: offset) }
    }
    private struct FollowRequest: Equatable {
        let contentHeight: CGFloat
        let visibleHeight: CGFloat
        let followsTail: Bool
        let userIsScrolling: Bool
        let navigationGeneration: Int
        let interactionIsPresented: Bool
        let sidebarIsTransitioning: Bool
        let tail: TimelineTailVisibility
    }
    private struct ScrollSettlement: Equatable {
        let phase: TimelineScrollState.Phase
        let tail: TimelineTailVisibility
        let generation: Int
    }
    private struct HistorySettlement: Equatable {
        let id: Int?
        let ready: Bool
        let offset: CGFloat?
    }
    private struct OpeningRequest: Equatable { let ready: Bool; let completed: Bool; let attempt: Int }
}

private struct ChatTimelineContent: View, Equatable {
    let model: SessionChatModel
    let onAttachment: (V2AttachmentContent) -> Void
    let onFile: (String) -> Void
    let latestPullReady: Bool
    let isLoadingLatest: Bool
    let olderPullReady: Bool
    let isLoadingOlder: Bool
    let keepsOlderPrompt: Bool
    let historyAnchor: TimelineHistoryLayout?
    let onLoadOlder: () -> Void
    let onLoadLatest: () -> Void
    let onHistoryLayout: (TimelineHistoryLayout) -> Void
    let onPromptVisibility: (Bool) -> Void
    let onOlderPromptVisibility: (Bool) -> Void
    let onTailVisibility: (TimelineTailVisibility.Region, Bool) -> Void

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.model === rhs.model && lhs.latestPullReady == rhs.latestPullReady && lhs.isLoadingLatest == rhs.isLoadingLatest
            && lhs.olderPullReady == rhs.olderPullReady && lhs.isLoadingOlder == rhs.isLoadingOlder
            && lhs.keepsOlderPrompt == rhs.keepsOlderPrompt && lhs.historyAnchor == rhs.historyAnchor
    }
    var body: some View {
        let groups = TimelineGrouping.groups(model.timeline.rows, interactionTargets: Set(model.session.notices.notices
            .filter(\.isVisible).compactMap(\.timelineTargetID)))
        let actions = TimelineTurnActions.build(groups: groups, suppressLatest: model.isRunning || model.session.hasNewerItems,
            hasPendingUserMessage: !model.session.hasNewerItems && (!model.timeline.pendingMessages.isEmpty || !model.session.pendingMessages.isEmpty))
        // Prefer a message whose start cannot move into a prefixed tool group.
        // For an all-tools page, retain the existing group's trailing edge.
        let anchorGroup = historyAnchor.flatMap { anchor in groups.first { $0.rows.contains { $0.id == anchor.anchorRowID } } }
            ?? groups.first { $0.rows.first?.structure.groupKind == .single } ?? groups.last
        let anchorEdge = historyAnchor?.edge ?? (anchorGroup?.rows.first?.structure.groupKind == .single ? .top : .bottom)
        // Keep actual row geometry available as Markdown grows and tool groups
        // change height. Hidden tool details own their deferred work separately.
        VStack(alignment: .leading, spacing: 20) {
            if model.session.hasOlderItems || keepsOlderPrompt {
                Group {
                    if isLoadingOlder {
                        HStack(spacing: 8) {
                            ProgressView().progressViewStyle(.circular).controlSize(.small)
                            Text("正在加载较早的消息…")
                        }.accessibilityElement(children: .combine)
                    } else if model.session.hasOlderItems {
                        Button(action: onLoadOlder) {
                            Text(olderPullReady ? "松开加载较早的消息" : "加载较早的消息")
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .contentShape(Rectangle())
                        }.disabled(model.session.isLoadingHistory || isLoadingLatest)
                    } else {
                        // Retain the prompt's footprint on the final page; removing
                        // it after restoring would move the reader by another row.
                        Text("已到达会话开头").foregroundStyle(.secondary)
                    }
                }
                .font(.footnote).frame(maxWidth: .infinity, minHeight: 44)
                .onScrollVisibilityChange(threshold: 0.9) { onOlderPromptVisibility($0) }
            }
            ForEach(groups) { group in
                SessionTimelineGroupView(group: group, chat: model, onAttachment: onAttachment, onFile: onFile,
                    turnAction: actions[group.id])
                    .id(group.id)
                    .background {
                        if group.id == anchorGroup?.id, let firstRowID = model.timeline.rows.first?.id {
                            Color.clear.onGeometryChange(for: TimelineHistoryLayout.self) { geometry in
                                let frame = geometry.frame(in: .named("chat.timeline.content"))
                                return TimelineHistoryLayout(firstRowID: firstRowID,
                                    anchorRowID: historyAnchor?.anchorRowID ?? group.id, edge: anchorEdge,
                                    y: anchorEdge == .top ? frame.minY : frame.maxY)
                            } action: { onHistoryLayout($0) }
                        }
                    }
            }
            ForEach(model.session.notices.notices.filter { notice in
                notice.isVisible && !notice.blocks(model.session.id)
                    && !model.timeline.rows.contains(where: { $0.id == notice.timelineTargetID })
            }) { item in SessionInteractionCard(item: item, chat: model) }
            ForEach(model.timeline.pendingMessages) { pending in
                PendingMessageRow(pending: pending, chat: model, onAttachment: onAttachment,
                    onDismiss: { model.session.dismissPendingMessage(id: pending.id) })
                    .id(pending.id)
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
                .disabled(model.session.isLoadingHistory || isLoadingLatest || isLoadingOlder)
                .onScrollVisibilityChange { onPromptVisibility($0) }
            }
            // Constant breathing room: status text and card counts cannot
            // change this spacer or create a spurious follow request.
            Color.clear.frame(height: 32)
                .overlay(alignment: .bottom) {
                    // Probes overlap existing content; their size never changes
                    // the spacer or the scroll view's content height.
                    Color.clear.frame(height: 96)
                        .onScrollVisibilityChange(threshold: 0.01) { onTailVisibility(.near, $0) }
                        .allowsHitTesting(false).accessibilityHidden(true)
                }
                .overlay(alignment: .bottom) {
                    Color.clear.frame(height: 2)
                        .onScrollVisibilityChange(threshold: 0.5) { onTailVisibility(.end, $0) }
                        .allowsHitTesting(false).accessibilityHidden(true)
                }
                .id("tail")
        }
        .scrollTargetLayout()
        .padding(.horizontal, 24).padding(.top, 16)
        .frame(maxWidth: 760).frame(maxWidth: .infinity)
        .coordinateSpace(name: "chat.timeline.content")
    }

}

private extension TimelineViewport {
    init(geometry: ScrollGeometry) {
        self.init(contentHeight: geometry.contentSize.height, containerHeight: geometry.containerSize.height,
            containerWidth: geometry.containerSize.width,
            topInset: geometry.contentInsets.top, bottomInset: geometry.contentInsets.bottom, offsetY: geometry.contentOffset.y)
    }
}
