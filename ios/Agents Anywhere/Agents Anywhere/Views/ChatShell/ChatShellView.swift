import SwiftUI

struct ChatShellView: View {
    @Environment(\.displayScale) private var displayScale

    @State private var drawerProgress: CGFloat = 0
    @State private var dragStartOffset: CGFloat?
    @State private var selectedConversation: ChatMockConversation?
    @State private var feedbackTrigger = 0

    var body: some View {
        GeometryReader { proxy in
            let metrics = ChatDrawerMetrics(
                containerWidth: proxy.size.width,
                progress: drawerProgress,
            )

            ZStack(alignment: .leading) {
                ChatDrawerLayer(
                    width: metrics.revealWidth,
                    safeAreaInsets: proxy.safeAreaInsets,
                    progress: metrics.progress,
                    selectedConversationID: selectedConversation?.id,
                    onSelectConversation: selectConversation,
                    onNewChat: startNewChat,
                )

                ChatCardLayer(
                    offset: metrics.offset,
                    progress: metrics.progress,
                    outlineWidth: 1 / max(displayScale, 1),
                    conversationTitle: selectedConversation?.title,
                    safeAreaInsets: proxy.safeAreaInsets,
                    onMenu: toggleSidebar,
                    onNewChat: startNewChat,
                    onDismiss: closeSidebar,
                )
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
            .contentShape(Rectangle())
            .simultaneousGesture(sidebarDragGesture(containerWidth: proxy.size.width))
            .ignoresSafeArea()
        }
        .background(Color(uiColor: .systemBackground))
        .sensoryFeedback(.impact(weight: .medium, intensity: 0.8), trigger: feedbackTrigger)
    }

    private func sidebarDragGesture(containerWidth: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8, coordinateSpace: .local)
            .onChanged { value in
                guard drawerProgress > 0 || value.startLocation.x <= ChatDrawerMetrics.edgeActivationWidth else {
                    return
                }

                let revealWidth = ChatDrawerMetrics.revealWidth(containerWidth: containerWidth)
                if dragStartOffset == nil {
                    dragStartOffset = drawerProgress * revealWidth
                }
                let startOffset = dragStartOffset ?? 0
                let currentOffset = min(max(startOffset + value.translation.width, 0), revealWidth)

                var transaction = Transaction()
                transaction.animation = nil
                withTransaction(transaction) {
                    drawerProgress = revealWidth > 0 ? currentOffset / revealWidth : 0
                }
            }
            .onEnded { value in
                guard let startOffset = dragStartOffset else { return }
                dragStartOffset = nil
                let revealWidth = ChatDrawerMetrics.revealWidth(containerWidth: containerWidth)
                let projectedOffset = startOffset + value.predictedEndTranslation.width
                setSidebarOpen(projectedOffset >= revealWidth * 0.5)
            }
    }

    private func selectConversation(_ conversation: ChatMockConversation) {
        selectedConversation = conversation
        setSidebarOpen(false)
    }

    private func startNewChat() {
        selectedConversation = nil
        setSidebarOpen(false)
    }

    private func toggleSidebar() {
        setSidebarOpen(drawerProgress < 0.5)
    }

    private func closeSidebar() {
        setSidebarOpen(false)
    }

    private func setSidebarOpen(_ isOpen: Bool) {
        let targetProgress: CGFloat = isOpen ? 1 : 0
        guard abs(drawerProgress - targetProgress) > 0.001 else { return }
        withAnimation(.spring(duration: 0.38, bounce: 0.08)) {
            drawerProgress = targetProgress
        }
        feedbackTrigger += 1
    }
}

private struct ChatDrawerLayer: View {
    let width: CGFloat
    let safeAreaInsets: EdgeInsets
    let progress: CGFloat
    let selectedConversationID: String?
    let onSelectConversation: (ChatMockConversation) -> Void
    let onNewChat: () -> Void

    var body: some View {
        ChatSidebarView(
            width: width,
            safeAreaInsets: safeAreaInsets,
            selectedConversationID: selectedConversationID,
            onSelectConversation: onSelectConversation,
            onNewChat: onNewChat,
        )
        .frame(width: width)
        .frame(maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
        .overlay {
            Color(uiColor: .systemBackground)
                .opacity(0.1 * (1 - progress))
                .allowsHitTesting(false)
        }
        .scaleEffect(0.9 + 0.1 * progress, anchor: .leading)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

private struct ChatCardLayer: View {
    let offset: CGFloat
    let progress: CGFloat
    let outlineWidth: CGFloat
    let conversationTitle: String?
    let safeAreaInsets: EdgeInsets
    let onMenu: () -> Void
    let onNewChat: () -> Void
    let onDismiss: () -> Void

    private let screenShape = ConcentricRectangle()

    var body: some View {
        ChatSurfaceView(
            conversationTitle: conversationTitle,
            safeAreaInsets: safeAreaInsets,
            onMenu: onMenu,
            onNewChat: onNewChat,
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            screenShape
                .fill(Color(uiColor: .systemBackground))
                .overlay {
                    screenShape
                        .fill(Color(uiColor: .secondarySystemBackground).opacity(progress))
                }
        }
        .clipShape(screenShape)
        .overlay {
            screenShape
                .stroke(.primary.opacity(0.16), lineWidth: outlineWidth)
        }
        .shadow(
            color: .black.opacity(0.34 * progress),
            radius: 28 * progress,
            x: -12 * progress,
        )
        .overlay {
            if progress > 0.98 {
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture(perform: onDismiss)
                    .accessibilityLabel("Close sidebar")
            }
        }
        .offset(x: offset)
        .zIndex(1)
    }
}

private struct ChatDrawerMetrics {
    static let edgeActivationWidth: CGFloat = 28
    static let revealFraction: CGFloat = 0.8

    let revealWidth: CGFloat
    let offset: CGFloat
    let progress: CGFloat

    init(containerWidth: CGFloat, progress: CGFloat) {
        let revealWidth = Self.revealWidth(containerWidth: containerWidth)
        let progress = min(max(progress, 0), 1)
        self.revealWidth = revealWidth
        offset = revealWidth * progress
        self.progress = progress
    }

    static func revealWidth(containerWidth: CGFloat) -> CGFloat {
        containerWidth * revealFraction
    }
}

#Preview {
    ChatShellView()
        .preferredColorScheme(.dark)
}
