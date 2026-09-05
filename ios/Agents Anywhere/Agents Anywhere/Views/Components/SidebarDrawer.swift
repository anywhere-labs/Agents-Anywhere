import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

struct SidebarDrawerConfiguration: Sendable {
    let revealFraction: CGFloat
    let edgeActivationWidth: CGFloat
    let sidebarClosedScale: CGFloat
    let sidebarOverlayOpacity: CGFloat
    let contentOverlayOpacity: CGFloat
    let sidebarHeaderEdgeEffectStyle: ScrollEdgeEffectStyle

    init(
        revealFraction: CGFloat = 0.75,
        edgeActivationWidth: CGFloat = 44,
        sidebarClosedScale: CGFloat = 0.95,
        sidebarOverlayOpacity: CGFloat = 0.5,
        contentOverlayOpacity: CGFloat = 0.14,
        sidebarHeaderEdgeEffectStyle: ScrollEdgeEffectStyle = .soft
    ) {
        self.revealFraction = revealFraction
        self.edgeActivationWidth = edgeActivationWidth
        self.sidebarClosedScale = sidebarClosedScale
        self.sidebarOverlayOpacity = sidebarOverlayOpacity
        self.contentOverlayOpacity = contentOverlayOpacity
        self.sidebarHeaderEdgeEffectStyle = sidebarHeaderEdgeEffectStyle
    }

    static let chat = SidebarDrawerConfiguration()
}

enum SidebarDrawerPresentation: Equatable, Sendable {
    case drawer
    case nativeSidebar
}

private struct SidebarDrawerPresentationKey: EnvironmentKey {
    static let defaultValue = SidebarDrawerPresentation.drawer
}

extension EnvironmentValues {
    var sidebarDrawerPresentation: SidebarDrawerPresentation {
        get { self[SidebarDrawerPresentationKey.self] }
        set { self[SidebarDrawerPresentationKey.self] = newValue }
    }
}

struct SidebarDrawer<SidebarHeader: View, SidebarContent: View, MainContent: View>: View {
    @Binding private var isOpen: Bool

    private let configuration: SidebarDrawerConfiguration
    private let sidebarHeader: (EdgeInsets) -> SidebarHeader
    private let sidebarContent: (EdgeInsets) -> SidebarContent
    private let mainContent: (EdgeInsets) -> MainContent

    init(
        isOpen: Binding<Bool>,
        configuration: SidebarDrawerConfiguration,
        @ViewBuilder sidebarHeader: @escaping (EdgeInsets) -> SidebarHeader,
        @ViewBuilder sidebar: @escaping (EdgeInsets) -> SidebarContent,
        @ViewBuilder content: @escaping (EdgeInsets) -> MainContent
    ) {
        _isOpen = isOpen
        self.configuration = configuration
        self.sidebarHeader = sidebarHeader
        self.sidebarContent = sidebar
        self.mainContent = content
    }

    var body: some View {
        if usesNativeSidebar {
            SidebarDrawerNativeSplitView(
                isOpen: $isOpen,
                sidebarHeaderEdgeEffectStyle: configuration.sidebarHeaderEdgeEffectStyle,
                sidebarHeader: sidebarHeader,
                sidebarContent: sidebarContent,
                mainContent: mainContent
            )
        } else {
            SidebarDrawerInteractive(
                isOpen: $isOpen,
                configuration: configuration,
                sidebarHeader: sidebarHeader,
                sidebarContent: sidebarContent,
                mainContent: mainContent
            )
        }
    }

    private var usesNativeSidebar: Bool {
#if os(iOS)
        UIDevice.current.userInterfaceIdiom == .pad
#else
        false
#endif
    }
}

private struct SidebarDrawerInteractive<
    SidebarHeader: View,
    SidebarContent: View,
    MainContent: View
>: View {
    @Binding private var isOpen: Bool

    private let configuration: SidebarDrawerConfiguration
    private let sidebarHeader: (EdgeInsets) -> SidebarHeader
    private let sidebarContent: (EdgeInsets) -> SidebarContent
    private let mainContent: (EdgeInsets) -> MainContent

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var progress: CGFloat
    @State private var dragStartProgress: CGFloat?
    @State private var dragDisposition: DragDisposition?
    @State private var animationGeneration = 0
    @State private var feedbackTrigger = 0

    init(
        isOpen: Binding<Bool>,
        configuration: SidebarDrawerConfiguration,
        sidebarHeader: @escaping (EdgeInsets) -> SidebarHeader,
        sidebarContent: @escaping (EdgeInsets) -> SidebarContent,
        mainContent: @escaping (EdgeInsets) -> MainContent
    ) {
        _isOpen = isOpen
        _progress = State(initialValue: isOpen.wrappedValue ? 1 : 0)
        self.configuration = configuration
        self.sidebarHeader = sidebarHeader
        self.sidebarContent = sidebarContent
        self.mainContent = mainContent
    }

    var body: some View {
        GeometryReader { safeAreaGeometry in
            let safeAreaInsets = safeAreaGeometry.safeAreaInsets

            GeometryReader { fullScreenGeometry in
                let screenSize = fullScreenGeometry.size
                let revealWidth = max(
                    screenSize.width * configuration.revealFraction.clamped(to: 0.01 ... 1),
                    1
                )

                ZStack(alignment: .leading) {
                    drawerSystemBackground

                    SidebarDrawerSidebar(
                        width: revealWidth,
                        safeAreaInsets: safeAreaInsets,
                        scale: sidebarScale,
                        overlayOpacity: sidebarOverlayOpacity,
                        edgeEffectStyle: configuration.sidebarHeaderEdgeEffectStyle,
                        header: sidebarHeader(safeAreaInsets),
                        content: sidebarContent(safeAreaInsets)
                    )

                    SidebarDrawerMainCard(
                        size: screenSize,
                        containerCornerInsets: fullScreenGeometry.containerCornerInsets,
                        progress: progress,
                        offset: revealWidth * progress,
                        overlayOpacity: contentOverlayOpacity,
                        content: mainContent(safeAreaInsets),
                        close: closeFromOverlay
                    )

#if !canImport(UIKit)
                    if usesOpeningEdgeGestureRegion {
                        Color.clear
                            .frame(
                                width: max(configuration.edgeActivationWidth, 0),
                                height: screenSize.height
                            )
                            .contentShape(Rectangle())
                            .highPriorityGesture(drawerGesture(revealWidth: revealWidth))
                    }
#endif
                }
                .frame(width: screenSize.width, height: screenSize.height)
                .contentShape(Rectangle())
#if canImport(UIKit)
                .gesture(
                    SidebarDrawerPanGesture(
                        progress: progress,
                        edgeActivationWidth: configuration.edgeActivationWidth,
                        onBegan: beginDirectionalPan,
                        onChanged: { translationX in
                            updateDirectionalPan(
                                translationX: translationX,
                                revealWidth: revealWidth
                            )
                        },
                        onEnded: { translationX, velocityX, cancelled in
                            endDirectionalPan(
                                translationX: translationX,
                                velocityX: velocityX,
                                revealWidth: revealWidth,
                                cancelled: cancelled
                            )
                        }
                    )
                )
#else
                .simultaneousGesture(
                    drawerGesture(revealWidth: revealWidth),
                    isEnabled: !usesOpeningEdgeGestureRegion
                )
#endif
                .onChange(of: isOpen) { _, newValue in
                    synchronizeProgress(with: newValue)
                }
            }
            .ignoresSafeArea()
        }
        .environment(\.sidebarDrawerPresentation, .drawer)
        .sensoryFeedback(
            .impact(weight: .light, intensity: 1),
            trigger: feedbackTrigger
        )
    }

    private var sidebarScale: CGFloat {
        let closedScale = configuration.sidebarClosedScale.clamped(to: 0 ... 1)
        return closedScale + ((1 - closedScale) * progress)
    }

    private var sidebarOverlayOpacity: CGFloat {
        configuration.sidebarOverlayOpacity.clamped(to: 0 ... 1) * (1 - progress)
    }

    private var contentOverlayOpacity: CGFloat {
        configuration.contentOverlayOpacity.clamped(to: 0 ... 1) * progress
    }

    private var usesOpeningEdgeGestureRegion: Bool {
        progress <= 0.001 || dragStartProgress.map { $0 <= 0.001 } == true
    }

    private func beginDirectionalPan() {
        animationGeneration &+= 1
        dragStartProgress = progress
    }

    private func updateDirectionalPan(translationX: CGFloat, revealWidth: CGFloat) {
        guard let dragStartProgress else { return }

        let nextProgress = dragStartProgress + (translationX / revealWidth)
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            progress = nextProgress.clamped(to: 0 ... 1)
        }
    }

    private func endDirectionalPan(
        translationX: CGFloat,
        velocityX: CGFloat,
        revealWidth: CGFloat,
        cancelled: Bool
    ) {
        defer { resetDrag() }
        guard let dragStartProgress else { return }

        let projectedTranslation = translationX + (velocityX * 0.2)
        let projectedProgress = dragStartProgress + (projectedTranslation / revealWidth)
        let target = if cancelled {
            progress >= 0.5 ? 1.0 : 0.0
        } else {
            projectedProgress >= 0.5 ? 1.0 : 0.0
        }

        settle(
            to: target,
            progressVelocity: velocityX / revealWidth,
            feedback: !cancelled
        )
    }

    private func drawerGesture(revealWidth: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8, coordinateSpace: .global)
            .onChanged { value in
                beginDragIfNeeded(value)

                guard
                    dragDisposition == .horizontal,
                    let dragStartProgress
                else {
                    return
                }

                let nextProgress = dragStartProgress + (value.translation.width / revealWidth)
                var transaction = Transaction(animation: nil)
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    progress = nextProgress.clamped(to: 0 ... 1)
                }
            }
            .onEnded { value in
                defer { resetDrag() }

                guard
                    dragDisposition == .horizontal,
                    let dragStartProgress
                else {
                    return
                }

                let predictedProgress = dragStartProgress
                    + (value.predictedEndTranslation.width / revealWidth)
                let progressVelocity = value.velocity.width / revealWidth
                settle(
                    to: predictedProgress >= 0.5 ? 1 : 0,
                    progressVelocity: progressVelocity,
                    feedback: true
                )
            }
    }

    private func beginDragIfNeeded(_ value: DragGesture.Value) {
        guard dragDisposition == nil else { return }

        let horizontalDistance = abs(value.translation.width)
        let verticalDistance = abs(value.translation.height)

        guard horizontalDistance > verticalDistance else {
            dragDisposition = .vertical
            return
        }

        guard canBeginHorizontalDrag(value) else {
            dragDisposition = .rejected
            return
        }

        animationGeneration &+= 1
        dragStartProgress = progress
        dragDisposition = .horizontal
    }

    private func canBeginHorizontalDrag(_ value: DragGesture.Value) -> Bool {
        if progress <= 0.001 {
            return value.startLocation.x <= max(configuration.edgeActivationWidth, 0)
                && value.translation.width > 0
        }

        if progress >= 0.999 {
            return value.translation.width < 0
        }

        return true
    }

    private func resetDrag() {
        dragStartProgress = nil
        dragDisposition = nil
    }

    private func closeFromOverlay() {
        guard progress > 0.001 else { return }
        settle(to: 0, feedback: true)
    }

    private func synchronizeProgress(with open: Bool) {
        let target: CGFloat = open ? 1 : 0
        guard abs(progress - target) > 0.001 else { return }
        settle(to: target, feedback: false)
    }

    // Confirms the snap immediately, then commits external semantic state on completion.
    private func settle(
        to rawTarget: CGFloat,
        progressVelocity: CGFloat = 0,
        feedback: Bool
    ) {
        let target = rawTarget.clamped(to: 0 ... 1)
        let shouldProvideFeedback = feedback && abs(progress - target) > 0.001
        let remainingProgress = target - progress
        let initialVelocity: Double = if abs(remainingProgress) > 0.001 {
            Double(progressVelocity / remainingProgress).clamped(to: -8 ... 8)
        } else {
            0.0
        }

        animationGeneration &+= 1
        let generation = animationGeneration

        if shouldProvideFeedback {
            feedbackTrigger &+= 1
        }

        let completion = {
            guard generation == animationGeneration else { return }

            progress = target
            let targetIsOpen = target == 1
            if isOpen != targetIsOpen {
                isOpen = targetIsOpen
            }
        }

        if reduceMotion {
            var transaction = Transaction(animation: nil)
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                progress = target
            }
            completion()
        } else {
            withAnimation(
                .interpolatingSpring(
                    Spring(response: 0.34, dampingRatio: 0.9),
                    initialVelocity: initialVelocity
                ),
                completionCriteria: .logicallyComplete
            ) {
                progress = target
            } completion: {
                completion()
            }
        }
    }
}

private struct SidebarDrawerNativeSplitView<
    SidebarHeader: View,
    SidebarContent: View,
    MainContent: View
>: View {
    @Binding private var isOpen: Bool

    private let sidebarHeader: (EdgeInsets) -> SidebarHeader
    private let sidebarContent: (EdgeInsets) -> SidebarContent
    private let mainContent: (EdgeInsets) -> MainContent
    private let sidebarHeaderEdgeEffectStyle: ScrollEdgeEffectStyle

    @State private var columnVisibility: NavigationSplitViewVisibility
    @State private var preferredCompactColumn: NavigationSplitViewColumn
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(
        isOpen: Binding<Bool>,
        sidebarHeaderEdgeEffectStyle: ScrollEdgeEffectStyle,
        sidebarHeader: @escaping (EdgeInsets) -> SidebarHeader,
        sidebarContent: @escaping (EdgeInsets) -> SidebarContent,
        mainContent: @escaping (EdgeInsets) -> MainContent
    ) {
        _isOpen = isOpen
        _columnVisibility = State(initialValue: isOpen.wrappedValue ? .all : .detailOnly)
        _preferredCompactColumn = State(initialValue: isOpen.wrappedValue ? .sidebar : .detail)
        self.sidebarHeaderEdgeEffectStyle = sidebarHeaderEdgeEffectStyle
        self.sidebarHeader = sidebarHeader
        self.sidebarContent = sidebarContent
        self.mainContent = mainContent
    }

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility, preferredCompactColumn: $preferredCompactColumn) {
            GeometryReader { geometry in
                let safeAreaInsets = geometry.safeAreaInsets

                SidebarDrawerNativeSidebar(
                    edgeEffectStyle: sidebarHeaderEdgeEffectStyle,
                    header: sidebarHeader(safeAreaInsets),
                    content: sidebarContent(safeAreaInsets)
                )
                .toolbar(removing: .sidebarToggle)
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 360)
        } detail: {
            GeometryReader { geometry in
                let safeAreaInsets = geometry.safeAreaInsets

                mainContent(safeAreaInsets)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationSplitViewStyle(.balanced)
        .environment(\.sidebarDrawerPresentation, .nativeSidebar)
        .onChange(of: isOpen) { _, newValue in
            updateColumns(open: newValue)
        }
        .onChange(of: columnVisibility) { _, newValue in
            guard horizontalSizeClass != .compact else { return }
            switch newValue {
            case .all, .doubleColumn:
                if !isOpen {
                    isOpen = true
                }
            case .detailOnly:
                if isOpen {
                    isOpen = false
                }
            case .automatic:
                break
            default:
                break
            }
        }
        .onChange(of: preferredCompactColumn) { _, column in
            guard horizontalSizeClass == .compact else { return }
            isOpen = column == .sidebar
        }
        .onChange(of: horizontalSizeClass) { _, _ in updateColumns(open: isOpen) }
    }

    private func updateColumns(open: Bool) {
        withAnimation(reduceMotion ? nil : .smooth(duration: 0.3)) {
            columnVisibility = open ? .all : .detailOnly
            preferredCompactColumn = open ? .sidebar : .detail
        }
    }
}

private struct SidebarDrawerNativeSidebar<Header: View, Content: View>: View {
    let edgeEffectStyle: ScrollEdgeEffectStyle
    let header: Header
    let content: Content

    var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .scrollEdgeEffectStyle(edgeEffectStyle, for: .top)
            .safeAreaBar(edge: .top, spacing: 0) {
                SidebarDrawerHeaderBar(
                    safeAreaInsets: EdgeInsets(),
                    header: header
                )
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct SidebarDrawerHeaderBar<Header: View>: View {
    let safeAreaInsets: EdgeInsets
    let header: Header

    var body: some View {
        header
            .padding(.top, safeAreaInsets.top)
            .padding(.leading, safeAreaInsets.leading)
            .padding(.trailing, safeAreaInsets.trailing)
            .frame(maxWidth: .infinity)
    }
}

private struct SidebarDrawerSidebar<Header: View, Content: View>: View {
    let width: CGFloat
    let safeAreaInsets: EdgeInsets
    let scale: CGFloat
    let overlayOpacity: CGFloat
    let edgeEffectStyle: ScrollEdgeEffectStyle
    let header: Header
    let content: Content

    var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .scrollEdgeEffectStyle(edgeEffectStyle, for: .top)
            .safeAreaBar(edge: .top, spacing: 0) {
                SidebarDrawerHeaderBar(
                    safeAreaInsets: safeAreaInsets,
                    header: header
                )
            }
            .frame(width: width)
            .frame(maxHeight: .infinity, alignment: .leading)
            .background(drawerSystemBackground)
            .overlay {
                drawerSystemBackground
                    .opacity(overlayOpacity)
                    .allowsHitTesting(false)
            }
            .scaleEffect(scale, anchor: .leading)
    }
}

private struct SidebarDrawerMainCard<Content: View>: View {
    let size: CGSize
    let containerCornerInsets: RectangleCornerInsets
    let progress: CGFloat
    let offset: CGFloat
    let overlayOpacity: CGFloat
    let content: Content
    let close: () -> Void

    var body: some View {
        let screenShape = ConcentricRectangle(
            topLeadingCorner: .concentric(
                minimum: .fixed(containerCornerInsets.topLeading.drawerCornerRadius)
            ),
            topTrailingCorner: .concentric(
                minimum: .fixed(containerCornerInsets.topTrailing.drawerCornerRadius)
            ),
            bottomLeadingCorner: .concentric(
                minimum: .fixed(containerCornerInsets.bottomLeading.drawerCornerRadius)
            ),
            bottomTrailingCorner: .concentric(
                minimum: .fixed(containerCornerInsets.bottomTrailing.drawerCornerRadius)
            )
        )

        content
            .frame(width: size.width, height: size.height)
            .background(drawerSystemBackground, in: screenShape)
            .clipShape(screenShape)
            .contentShape(screenShape)
            .overlay {
                screenShape
                    .fill(.white.opacity(overlayOpacity))
                    .contentShape(screenShape)
                    .onTapGesture(perform: close)
                    .allowsHitTesting(progress > 0.001)
            }
            .overlay {
                screenShape
                    .stroke(
                        Color.primary.opacity(0.2 * progress),
                        lineWidth: 1
                    )
                    .allowsHitTesting(false)
            }
            .compositingGroup()
            .shadow(
                color: .black.opacity(0.28 * progress),
                radius: 18 * progress,
                x: -3 * progress,
                y: 0
            )
            .offset(x: offset)
    }
}

private enum DragDisposition {
    case horizontal
    case vertical
    case rejected
}

private extension CGFloat {
    func clamped(to range: ClosedRange<CGFloat>) -> CGFloat {
        Swift.min(Swift.max(self, range.lowerBound), range.upperBound)
    }
}

private extension Double {
    func clamped(to range: ClosedRange<Double>) -> Double {
        Swift.min(Swift.max(self, range.lowerBound), range.upperBound)
    }
}

private extension CGSize {
    var drawerCornerRadius: CGFloat {
        max(width, height)
    }
}

private var drawerSystemBackground: Color {
#if canImport(UIKit)
    Color(uiColor: .systemBackground)
#elseif canImport(AppKit)
    Color(nsColor: .windowBackgroundColor)
#else
    Color.clear
#endif
}
