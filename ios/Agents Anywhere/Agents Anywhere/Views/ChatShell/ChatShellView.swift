import SwiftUI

struct ChatShellView: View {
    @Environment(\.displayScale) private var displayScale

    @State private var isSidebarOpen = false
    @State private var selectedConversation: ChatMockConversation?
    @State private var feedbackTrigger = 0
    @GestureState private var dragTranslation: CGFloat = 0

    var body: some View {
        GeometryReader { proxy in
            let metrics = ChatDrawerMetrics(
                containerWidth: proxy.size.width,
                isOpen: isSidebarOpen,
                dragTranslation: dragTranslation,
            )

            ZStack(alignment: .leading) {
                ChatDrawerLayer(
                    width: metrics.revealWidth,
                    topInset: proxy.safeAreaInsets.top,
                    bottomInset: proxy.safeAreaInsets.bottom,
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
                    topInset: proxy.safeAreaInsets.top,
                    bottomInset: proxy.safeAreaInsets.bottom,
                    onMenu: toggleSidebar,
                    onNewChat: startNewChat,
                    onDismiss: closeSidebar,
                )
            }
            .contentShape(Rectangle())
            .simultaneousGesture(sidebarDragGesture(containerWidth: proxy.size.width))
        }
        .ignoresSafeArea()
        .background(Color(uiColor: .systemBackground))
        .sensoryFeedback(.impact(weight: .medium, intensity: 0.8), trigger: feedbackTrigger)
    }

    private func sidebarDragGesture(containerWidth: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8, coordinateSpace: .local)
            .updating($dragTranslation) { value, translation, _ in
                guard isSidebarOpen || value.startLocation.x <= ChatDrawerMetrics.edgeActivationWidth else {
                    return
                }
                translation = value.translation.width
            }
            .onEnded { value in
                guard isSidebarOpen || value.startLocation.x <= ChatDrawerMetrics.edgeActivationWidth else {
                    return
                }
                let revealWidth = ChatDrawerMetrics.revealWidth(containerWidth: containerWidth)
                let baseOffset = isSidebarOpen ? revealWidth : 0
                let projectedOffset = baseOffset + value.predictedEndTranslation.width
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
        setSidebarOpen(!isSidebarOpen)
    }

    private func closeSidebar() {
        setSidebarOpen(false)
    }

    private func setSidebarOpen(_ isOpen: Bool) {
        guard isSidebarOpen != isOpen else { return }
        withAnimation(.spring(duration: 0.38, bounce: 0.08)) {
            isSidebarOpen = isOpen
        }
        feedbackTrigger += 1
    }
}

private struct ChatDrawerLayer: View {
    let width: CGFloat
    let topInset: CGFloat
    let bottomInset: CGFloat
    let progress: CGFloat
    let selectedConversationID: String?
    let onSelectConversation: (ChatMockConversation) -> Void
    let onNewChat: () -> Void

    var body: some View {
        ChatSidebarView(
            width: width,
            topInset: topInset,
            bottomInset: bottomInset,
            selectedConversationID: selectedConversationID,
            onSelectConversation: onSelectConversation,
            onNewChat: onNewChat,
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(Color(uiColor: .systemBackground))
        .overlay {
            Color.primary
                .opacity(0.1 * (1 - progress))
                .allowsHitTesting(false)
        }
        .scaleEffect(0.9 + 0.1 * progress, anchor: .leading)
    }
}

private struct ChatCardLayer: View {
    let offset: CGFloat
    let progress: CGFloat
    let outlineWidth: CGFloat
    let conversationTitle: String?
    let topInset: CGFloat
    let bottomInset: CGFloat
    let onMenu: () -> Void
    let onNewChat: () -> Void
    let onDismiss: () -> Void

    private let screenShape = ConcentricRectangle()

    var body: some View {
        ChatSurfaceView(
            conversationTitle: conversationTitle,
            topInset: topInset,
            bottomInset: bottomInset,
            onMenu: onMenu,
            onNewChat: onNewChat,
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            ZStack {
                Color(uiColor: .systemBackground)
                Color(uiColor: .secondarySystemBackground)
                    .opacity(progress)
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

    init(containerWidth: CGFloat, isOpen: Bool, dragTranslation: CGFloat) {
        let revealWidth = Self.revealWidth(containerWidth: containerWidth)
        let baseOffset = isOpen ? revealWidth : 0
        let offset = min(max(baseOffset + dragTranslation, 0), revealWidth)
        self.revealWidth = revealWidth
        self.offset = offset
        progress = revealWidth > 0 ? offset / revealWidth : 0
    }

    static func revealWidth(containerWidth: CGFloat) -> CGFloat {
        containerWidth * revealFraction
    }
}

#Preview {
    ChatShellView()
        .preferredColorScheme(.dark)
}
