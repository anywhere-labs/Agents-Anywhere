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

private struct SidebarDrawerTransitionKey: EnvironmentKey {
    static let defaultValue = false
}

private struct SidebarDrawerObscuresDetailKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var sidebarDrawerObscuresDetail: Bool {
        get { self[SidebarDrawerObscuresDetailKey.self] }
        set { self[SidebarDrawerObscuresDetailKey.self] = newValue }
    }
    var sidebarDrawerIsTransitioning: Bool {
        get { self[SidebarDrawerTransitionKey.self] }
        set { self[SidebarDrawerTransitionKey.self] = newValue }
    }
    var sidebarDrawerPresentation: SidebarDrawerPresentation {
        get { self[SidebarDrawerPresentationKey.self] }
        set { self[SidebarDrawerPresentationKey.self] = newValue }
    }
}

/// Runs work only while the drawer rests closed over the page. The drawer
/// flips its environment when a pan begins and ends; reading it here keeps
/// that flip from re-evaluating the entire page body in the middle of motion.
private struct SidebarDrawerSettledTask<ID: Equatable>: ViewModifier {
    let id: ID
    let action: (_ settled: Bool) async -> Void
    @Environment(\.sidebarDrawerIsTransitioning) private var isTransitioning
    @Environment(\.sidebarDrawerObscuresDetail) private var obscuresDetail

    private struct Key: Equatable {
        let id: ID
        let settled: Bool
    }

    func body(content: Content) -> some View {
        let settled = !isTransitioning && !obscuresDetail
        content.task(id: Key(id: id, settled: settled)) { await action(settled) }
    }
}

extension View {
    /// Like `task(id:)`, restarted whenever the drawer settles or starts moving.
    func sidebarDrawerSettledTask<ID: Equatable>(
        id: ID,
        _ action: @escaping (_ settled: Bool) async -> Void
    ) -> some View {
        modifier(SidebarDrawerSettledTask(id: id, action: action))
    }
}

struct SidebarDrawer<SidebarHeader: View, SidebarContent: View, MainContent: View>: View {
    @Binding private var isOpen: Bool

    private let presentation: SidebarDrawerPresentation
    private let configuration: SidebarDrawerConfiguration
    private let sidebarHeader: (EdgeInsets) -> SidebarHeader
    private let sidebarContent: (EdgeInsets) -> SidebarContent
    private let mainContent: (EdgeInsets) -> MainContent

    init(
        isOpen: Binding<Bool>,
        presentation: SidebarDrawerPresentation,
        configuration: SidebarDrawerConfiguration,
        @ViewBuilder sidebarHeader: @escaping (EdgeInsets) -> SidebarHeader,
        @ViewBuilder sidebar: @escaping (EdgeInsets) -> SidebarContent,
        @ViewBuilder content: @escaping (EdgeInsets) -> MainContent
    ) {
        _isOpen = isOpen
        self.presentation = presentation
        self.configuration = configuration
        self.sidebarHeader = sidebarHeader
        self.sidebarContent = sidebar
        self.mainContent = content
    }

    var body: some View {
        if presentation == .nativeSidebar {
            SidebarDrawerNativeSplitView(
                isOpen: $isOpen,
                sidebarHeaderEdgeEffectStyle: configuration.sidebarHeaderEdgeEffectStyle,
                sidebarHeader: sidebarHeader,
                sidebarContent: sidebarContent,
                mainContent: mainContent
            )
        } else {
            // Resolve page builders above the state that changes on every pan
            // sample. Equality on the resulting page cannot prevent expensive
            // work that has already happened in its initializer.
            GeometryReader { geometry in
                SidebarDrawerPages(
                    isOpen: $isOpen,
                    configuration: configuration,
                    safeAreaInsets: geometry.safeAreaInsets,
                    sidebarHeader: sidebarHeader,
                    sidebarContent: sidebarContent,
                    mainContent: mainContent
                )
            }
        }
    }
}

/// GeometryReader can revisit its closure even when the insets are unchanged.
/// A view boundary keeps that layout pass from invoking the page factories.
private struct SidebarDrawerPages<SidebarHeader: View, SidebarContent: View, MainContent: View>: View {
    @Binding var isOpen: Bool
    let configuration: SidebarDrawerConfiguration
    let safeAreaInsets: EdgeInsets
    let sidebarHeader: (EdgeInsets) -> SidebarHeader
    let sidebarContent: (EdgeInsets) -> SidebarContent
    let mainContent: (EdgeInsets) -> MainContent

    var body: some View {
        SidebarDrawerInteractive(
            isOpen: $isOpen,
            configuration: configuration,
            safeAreaInsets: safeAreaInsets,
            sidebarHeader: sidebarHeader(safeAreaInsets),
            sidebarContent: sidebarContent(safeAreaInsets),
            mainContent: mainContent(safeAreaInsets)
        )
    }
}

private struct SidebarDrawerInteractive<
    SidebarHeader: View,
    SidebarContent: View,
    MainContent: View
>: View {
    @Binding private var isOpen: Bool

    private let configuration: SidebarDrawerConfiguration
    private let safeAreaInsets: EdgeInsets
    private let sidebarHeader: SidebarHeader
    private let sidebarContent: SidebarContent
    private let mainContent: MainContent

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var motion: SidebarDrawerMotion
    @State private var dragStartProgress: CGFloat?
    @State private var dragDisposition: DragDisposition?
    @State private var animationGeneration = 0
    @State private var isAnimating = false
    @State private var feedbackTrigger = 0

    init(
        isOpen: Binding<Bool>,
        configuration: SidebarDrawerConfiguration,
        safeAreaInsets: EdgeInsets,
        sidebarHeader: SidebarHeader,
        sidebarContent: SidebarContent,
        mainContent: MainContent
    ) {
        _isOpen = isOpen
        _motion = State(initialValue: SidebarDrawerMotion(progress: isOpen.wrappedValue ? 1 : 0))
        self.configuration = configuration
        self.safeAreaInsets = safeAreaInsets
        self.sidebarHeader = sidebarHeader
        self.sidebarContent = sidebarContent
        self.mainContent = mainContent
    }

    var body: some View {
        GeometryReader { fullScreenGeometry in
            let screenSize = fullScreenGeometry.size
            let revealWidth = max(
                screenSize.width * configuration.revealFraction.clamped(to: 0.01 ... 1),
                1
            )
            let interaction = DrawerInteractionState(isOpen: isOpen, progress: motion.restingProgress,
                isAnimating: isAnimating, isDragging: dragStartProgress != nil)

            ZStack(alignment: .leading) {
                drawerSystemBackground

                SidebarDrawerSidebar(
                    width: revealWidth,
                    safeAreaInsets: safeAreaInsets,
                    edgeEffectStyle: configuration.sidebarHeaderEdgeEffectStyle,
                    header: sidebarHeader,
                    content: sidebarContent
                )
                .modifier(SidebarDrawerSidebarMotion(
                    motion: motion,
                    closedScale: configuration.sidebarClosedScale.clamped(to: 0 ... 1),
                    overlayOpacity: configuration.sidebarOverlayOpacity.clamped(to: 0 ... 1)
                ))
                .allowsHitTesting(interaction.acceptsSidebarTouches)
                .accessibilityHidden(!interaction.acceptsSidebarTouches)

                SidebarDrawerMainCard(
                    size: screenSize,
                    isFullyClosed: interaction.acceptsContentTouches,
                    content: mainContent
                )
                .modifier(SidebarDrawerCardMotion(
                    motion: motion,
                    isFullyClosed: interaction.acceptsContentTouches,
                    revealWidth: revealWidth,
                    overlayOpacity: configuration.contentOverlayOpacity.clamped(to: 0 ... 1)
                ))
                .allowsHitTesting(interaction.acceptsContentTouches)
                .accessibilityHidden(!interaction.acceptsContentTouches)

                // Only the screen-space strip occupied by the visible card
                // closes the drawer. Its untranslated hit targets are disabled.
                SidebarDrawerCloseArea(motion: motion, revealWidth: revealWidth)
                    .onTapGesture(perform: closeFromOverlay)
                    .allowsHitTesting(interaction.acceptsSidebarTouches)
                    .accessibilityHidden(!interaction.acceptsSidebarTouches)
                    .accessibilityLabel(String(localized: "关闭侧栏"))
                    .accessibilityAddTraits(.isButton)

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
                    progress: motion.restingProgress,
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
        .environment(\.sidebarDrawerPresentation, .drawer)
        .environment(\.sidebarDrawerObscuresDetail, isOpen || motion.restingProgress > 0)
        .environment(\.sidebarDrawerIsTransitioning, isAnimating || dragStartProgress != nil
            || motion.restingProgress != (isOpen ? 1 : 0))
        .sensoryFeedback(
            .impact(weight: .light, intensity: 1),
            trigger: feedbackTrigger
        )
    }

    private var usesOpeningEdgeGestureRegion: Bool {
        motion.restingProgress == 0 || dragStartProgress.map { $0 <= 0.001 } == true
    }

    private func beginDirectionalPan() {
        animationGeneration &+= 1
        dragStartProgress = motion.progress
    }

    private func updateDirectionalPan(translationX: CGFloat, revealWidth: CGFloat) {
        guard let dragStartProgress else { return }

        let nextProgress = dragStartProgress + (translationX / revealWidth)
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            motion.move(to: nextProgress.clamped(to: 0 ... 1))
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
            motion.progress >= 0.5 ? 1.0 : 0.0
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
                    motion.move(to: nextProgress.clamped(to: 0 ... 1))
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
        dragStartProgress = motion.progress
        dragDisposition = .horizontal
    }

    private func canBeginHorizontalDrag(_ value: DragGesture.Value) -> Bool {
        if motion.progress <= 0.001 {
            return value.startLocation.x <= max(configuration.edgeActivationWidth, 0)
                && value.translation.width > 0
        }

        if motion.progress >= 0.999 {
            return value.translation.width < 0
        }

        return true
    }

    private func resetDrag() {
        dragStartProgress = nil
        dragDisposition = nil
    }

    private func closeFromOverlay() {
        guard motion.progress > 0.001 else { return }
        settle(to: 0, feedback: true)
    }

    private func synchronizeProgress(with open: Bool) {
        let target: CGFloat = open ? 1 : 0
        guard abs(motion.progress - target) > 0.001 else { return }
        settle(to: target, feedback: false)
    }

    // Confirms the snap immediately, then commits external semantic state on completion.
    private func settle(
        to rawTarget: CGFloat,
        progressVelocity: CGFloat = 0,
        feedback: Bool
    ) {
        let target = rawTarget.clamped(to: 0 ... 1)
        let shouldProvideFeedback = feedback && abs(motion.progress - target) > 0.001
        let remainingProgress = target - motion.progress
        let initialVelocity: Double = if abs(remainingProgress) > 0.001 {
            Double(progressVelocity / remainingProgress).clamped(to: -8 ... 8)
        } else {
            0.0
        }

        animationGeneration &+= 1
        let generation = animationGeneration
        isAnimating = true

        if shouldProvideFeedback {
            feedbackTrigger &+= 1
        }

        let completion = {
            guard generation == animationGeneration else { return }

            isAnimating = false
            motion.move(to: target)
            let targetIsOpen = target == 1
            if isOpen != targetIsOpen {
                isOpen = targetIsOpen
            }
        }

        if reduceMotion {
            var transaction = Transaction(animation: nil)
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                motion.move(to: target)
            }
            completion()
        } else {
            withAnimation(
                .interpolatingSpring(
                    Spring(response: 0.34, dampingRatio: 0.9),
                    initialVelocity: initialVelocity
                ),
                completionCriteria: .removed
            ) {
                motion.move(to: target)
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
    @State private var isAnimating = false
    @State private var animationGeneration = 0
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
        self.sidebarHeaderEdgeEffectStyle = sidebarHeaderEdgeEffectStyle
        self.sidebarHeader = sidebarHeader
        self.sidebarContent = sidebarContent
        self.mainContent = mainContent
    }

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
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
                mainContent(geometry.safeAreaInsets)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationSplitViewStyle(.balanced)
        .environment(\.sidebarDrawerPresentation, .nativeSidebar)
        .environment(\.sidebarDrawerIsTransitioning, isAnimating || columnsNeedUpdate)
        .onChange(of: isOpen) { _, newValue in
            updateColumns(open: newValue)
        }
        .onChange(of: columnVisibility) { _, newValue in
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
    }

    private func updateColumns(open: Bool) {
        animationGeneration &+= 1
        let generation = animationGeneration
        isAnimating = true
        withAnimation(reduceMotion ? nil : .smooth(duration: 0.3), completionCriteria: .removed) {
            columnVisibility = open ? .all : .detailOnly
        } completion: {
            if animationGeneration == generation { isAnimating = false }
        }
    }

    private var columnsNeedUpdate: Bool {
        switch columnVisibility {
        case .all, .doubleColumn: return !isOpen
        case .detailOnly: return isOpen
        default: return false
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
    }
}

private struct SidebarDrawerMainCard<Content: View>: View {
    let size: CGSize
    let isFullyClosed: Bool
    let content: Content

    var body: some View {
        // Once settled, cover the entire window and let the system clip its
        // outer corners. A second rounded edge can expose the sidebar beneath.
        // Keep the concentric card throughout every drag and spring frame.
        let screenShape = SidebarDrawerCardShape.shape(isFullyClosed: isFullyClosed)

        content
            // The untransformed host supplies all original insets, including
            // the keyboard. Apply them once inside the page, never again from
            // this moving card's intersection with the window.
            .ignoresSafeArea()
            .frame(width: size.width, height: size.height)
            .background(drawerSystemBackground, in: screenShape)
            .clipShape(screenShape)
            .contentShape(screenShape)
    }
}

private enum SidebarDrawerCardShape {
    static func shape(isFullyClosed: Bool) -> ConcentricRectangle {
        ConcentricRectangle(corners: isFullyClosed ? .fixed(0) : .concentric)
    }
}

/// Drawer position, read only by the small render modifiers below. A pan
/// sample then updates their effects without re-evaluating the drawer
/// container, the page modifier chains, or anything that reads the drawer's
/// environment. Code that only needs to know where the drawer rests reads
/// `restingProgress`, which changes once per gesture instead of every frame.
@MainActor @Observable final class SidebarDrawerMotion {
    private(set) var progress: CGFloat
    /// 0 when closed, 1 when fully open, 0.5 anywhere in between.
    private(set) var restingProgress: CGFloat

    init(progress: CGFloat) {
        self.progress = progress
        restingProgress = Self.resting(progress)
    }

    func move(to next: CGFloat) {
        progress = next
        let resting = Self.resting(next)
        if restingProgress != resting { restingProgress = resting }
    }

    private static func resting(_ progress: CGFloat) -> CGFloat {
        progress <= 0.001 ? 0 : progress >= 0.999 ? 1 : 0.5
    }
}

private struct SidebarDrawerSidebarMotion: ViewModifier {
    let motion: SidebarDrawerMotion
    let closedScale: CGFloat
    let overlayOpacity: CGFloat

    func body(content: Content) -> some View {
        let progress = motion.progress
        content
            .overlay {
                drawerSystemBackground
                    .opacity(overlayOpacity * (1 - progress))
                    .allowsHitTesting(false)
            }
            .scaleEffect(closedScale + ((1 - closedScale) * progress), anchor: .leading)
    }
}

private struct SidebarDrawerCardMotion: ViewModifier {
    let motion: SidebarDrawerMotion
    let isFullyClosed: Bool
    let revealWidth: CGFloat
    let overlayOpacity: CGFloat

    func body(content: Content) -> some View {
        let progress = motion.progress
        let screenShape = SidebarDrawerCardShape.shape(isFullyClosed: isFullyClosed)

        content
            .background {
                // Shadow only the card shape. Compositing the entire conversation
                // into an animated shadow layer repaints its text during a pan.
                // Keep the drawn shadow constant and fade its layer: a changing
                // radius re-blurs a full-screen shape on every frame.
                screenShape.fill(drawerSystemBackground)
                    .shadow(color: .black.opacity(0.28), radius: 18, x: -3, y: 0)
                    .opacity(progress)
                    .allowsHitTesting(false)
            }
            // Constant fills with layer opacity composite without redrawing.
            .overlay {
                screenShape
                    .fill(.white)
                    .opacity(overlayOpacity * progress)
                    .allowsHitTesting(false)
            }
            .overlay {
                screenShape
                    .stroke(Color.primary.opacity(0.2), lineWidth: 1)
                    .opacity(progress)
                    .allowsHitTesting(false)
            }
            // Ordinary offset still participates in descendant coordinates:
            // subpixel motion can round this 402-point column to 402 1/3 and
            // change paragraph wrapping. Keep the whole translation out of
            // layout, including every interpolated frame of the spring.
            .modifier(SidebarDrawerTranslation(x: revealWidth * progress).ignoredByLayout())
    }
}

/// Screen-space strip occupied by the visible card while the drawer is open.
private struct SidebarDrawerCloseArea: View {
    let motion: SidebarDrawerMotion
    let revealWidth: CGFloat

    var body: some View {
        let region = SidebarDrawerCloseRegion(leadingEdge: revealWidth * motion.progress)
        region.fill(.clear)
            .contentShape(.interaction, region)
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

private var drawerSystemBackground: Color {
#if canImport(UIKit)
    Color(uiColor: .systemBackground)
#elseif canImport(AppKit)
    Color(nsColor: .windowBackgroundColor)
#else
    Color.clear
#endif
}
