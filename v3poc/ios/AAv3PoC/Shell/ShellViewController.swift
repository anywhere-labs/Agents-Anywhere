import SwiftUI
import UIKit

/// The app's root, in UIKit: the sidebar, and the conversation in its card (a UINavigationController around
/// `ConversationViewController`). On a phone the card slides over the sidebar like the real app's drawer; at regular
/// width (iPad) the sidebar is a column beside it.
///
/// Touch ownership: the drawer has no recognizer on any ancestor of the web view. It is opened only from a 20 pt strip
/// on the left edge (a sibling view above the card) and, while open, closed only from the part of the card left on
/// screen (another sibling, covering just that strip). Everywhere else a touch on the thread belongs to the web view.
final class ShellViewController: UIViewController, UIGestureRecognizerDelegate {
    static let edgeWidth: CGFloat = 20
    private static let revealFraction: CGFloat = 0.75
    private static let sidebarClosedScale: CGFloat = 0.95

    let controller: SessionController
    private let sidebarInsets = SidebarInsets()
    private var sidebarHost: UIHostingController<SidebarColumn>!
    private let conversation: ConversationViewController
    private let navigation: UINavigationController

    private let cardView = UIView()
    private let cardShadow = UIView()
    private let cardClip = UIView()
    private let cardTint = UIView()
    private let cardStroke = UIView()
    private let sidebarDim = UIView()
    private let edgeStrip = UIView()
    private let closeArea = UIView()

    private(set) var isOpen = DebugLaunch.drawerOpen
    /// 0 closed … 1 open: where the card is (phone drawer only).
    private var progress: CGFloat
    private var dragStart: CGFloat?
    private var animator: UIViewPropertyAnimator?
    private var appeared = false
    private var isSplit: Bool { traitCollection.horizontalSizeClass == .regular }
    private var revealWidth: CGFloat { max(view.bounds.width * Self.revealFraction, 1) }
    private var splitSidebarWidth: CGFloat { min(360, max(260, view.bounds.width * 0.3)) }

    init(controller: SessionController) {
        self.controller = controller
        conversation = ConversationViewController(controller: controller)
        navigation = UINavigationController(rootViewController: conversation)
        progress = DebugLaunch.drawerHold.map { CGFloat($0) } ?? (isOpen ? 1 : 0)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        sidebarHost = UIHostingController(rootView: SidebarColumn(controller: controller, insets: sidebarInsets) { [weak self] id in
            self?.open(id)
        })
        // Like the real drawer: the sidebar draws under the status bar and home indicator and pads itself.
        sidebarHost.safeAreaRegions = []
        sidebarHost.view.backgroundColor = .systemBackground
        addChild(sidebarHost)
        view.addSubview(sidebarHost.view)
        sidebarHost.didMove(toParent: self)
        sidebarDim.backgroundColor = .systemBackground
        sidebarDim.isUserInteractionEnabled = false
        view.addSubview(sidebarDim)

        // The shadow is cast from `shadowPath` alone (rounded like the card); the view itself draws nothing, so no
        // square corner of it shows outside the card's rounded clip.
        cardShadow.backgroundColor = .clear
        cardShadow.layer.shadowColor = UIColor.black.cgColor
        cardShadow.layer.shadowOpacity = 0.28
        cardShadow.layer.shadowRadius = 18
        cardShadow.layer.shadowOffset = CGSize(width: -3, height: 0)
        cardShadow.isUserInteractionEnabled = false
        cardView.addSubview(cardShadow)
        cardClip.clipsToBounds = true
        cardClip.backgroundColor = .systemBackground
        cardView.addSubview(cardClip)
        // The navigation controller has no back stack here; its edge-pop recognizers stay off.
        navigation.interactivePopGestureRecognizer?.isEnabled = false
        navigation.interactiveContentPopGestureRecognizer?.isEnabled = false
        navigation.navigationBar.tintColor = .label
        addChild(navigation)
        cardClip.addSubview(navigation.view)
        navigation.didMove(toParent: self)
        cardTint.backgroundColor = .white
        cardTint.isUserInteractionEnabled = false
        cardClip.addSubview(cardTint)
        cardStroke.layer.borderWidth = 1
        cardStroke.isUserInteractionEnabled = false
        cardClip.addSubview(cardStroke)
        view.addSubview(cardView)

        let edgePan = UIPanGestureRecognizer(target: self, action: #selector(pan(_:)))
        edgePan.maximumNumberOfTouches = 1
        edgePan.delegate = self
        edgeStrip.addGestureRecognizer(edgePan)
        edgeStrip.accessibilityElementsHidden = true
        view.addSubview(edgeStrip)

        let closePan = UIPanGestureRecognizer(target: self, action: #selector(pan(_:)))
        closePan.maximumNumberOfTouches = 1
        closePan.delegate = self
        closeArea.addGestureRecognizer(closePan)
        closeArea.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(closeTapped)))
        closeArea.isAccessibilityElement = true
        closeArea.accessibilityLabel = "关闭侧栏"
        closeArea.accessibilityTraits = .button
        view.addSubview(closeArea)

        conversation.onMenu = { [weak self] in self?.setOpen(!(self?.isOpen ?? false), animated: true) }
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _: UITraitCollection) in self.updateColors() }
        registerForTraitChanges([UITraitHorizontalSizeClass.self]) { (self: Self, _: UITraitCollection) in
            self.view.setNeedsLayout()
        }
        updateColors()
        startSession()
    }

    override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        // At regular width the sidebar column starts shown, like the real app's split view.
        if isSplit, !appeared { isOpen = true }
        appeared = true
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        let insets = view.safeAreaInsets
        sidebarInsets.value = EdgeInsets(top: insets.top, leading: insets.left, bottom: insets.bottom, trailing: insets.right)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let bounds = view.bounds
        if isSplit {
            cardView.transform = .identity
            sidebarHost.view.transform = .identity
            sidebarHost.view.frame = CGRect(x: 0, y: 0, width: splitSidebarWidth, height: bounds.height)
            let x = isOpen ? splitSidebarWidth : 0
            cardView.frame = CGRect(x: x, y: 0, width: bounds.width - x, height: bounds.height)
        } else {
            sidebarHost.view.bounds = CGRect(x: 0, y: 0, width: revealWidth, height: bounds.height)
            sidebarHost.view.center = CGPoint(x: revealWidth / 2, y: bounds.midY)
            cardView.bounds = bounds
            cardView.center = CGPoint(x: bounds.midX, y: bounds.midY)
        }
        sidebarDim.frame = sidebarHost.view.frame
        for subview in [cardShadow, cardClip] { subview.frame = cardView.bounds }
        for subview in [navigation.view!, cardTint, cardStroke] { subview.frame = cardClip.bounds }
        applyCardRadius()
        edgeStrip.frame = CGRect(x: 0, y: view.safeAreaInsets.top, width: Self.edgeWidth, height: bounds.height - view.safeAreaInsets.top)
        if dragStart == nil, animator == nil { apply(progress) }
        updateInteraction()
    }

    // MARK: Drawer state

    func setOpen(_ open: Bool, animated: Bool) {
        if isSplit {
            isOpen = open
            UIView.animate(withDuration: animated && !UIAccessibility.isReduceMotionEnabled ? 0.3 : 0) {
                self.view.setNeedsLayout()
                self.view.layoutIfNeeded()
            }
            return
        }
        settle(to: open ? 1 : 0, velocity: 0, feedback: false, animated: animated)
    }

    private func open(_ id: String) {
        controller.select(id)
        if !isSplit { setOpen(false, animated: true) }
    }

    /// Card, sidebar and their decorations for a drawer position (inside an animation block when settling).
    private func apply(_ value: CGFloat) {
        guard !isSplit else {
            cardShadow.alpha = 0; cardTint.alpha = 0; cardStroke.alpha = 0; sidebarDim.alpha = 0
            setCardRadius(0)
            return
        }
        let p = min(max(value, 0), 1)
        cardView.transform = CGAffineTransform(translationX: revealWidth * p, y: 0)
        cardShadow.alpha = p
        cardTint.alpha = 0.14 * p
        cardStroke.alpha = p
        let scale = Self.sidebarClosedScale + (1 - Self.sidebarClosedScale) * p
        // Scale about the sidebar's leading edge.
        sidebarHost.view.transform = CGAffineTransform(translationX: -revealWidth * (1 - scale) / 2, y: 0).scaledBy(x: scale, y: scale)
        sidebarDim.transform = sidebarHost.view.transform
        sidebarDim.alpha = 0.5 * (1 - p)
        closeArea.frame = CGRect(x: revealWidth * p, y: 0, width: view.bounds.width - revealWidth * p, height: view.bounds.height)
    }

    /// Settled state → which surface takes touches. Only flips while no drawer drag is in progress.
    private func updateInteraction() {
        if isSplit {
            cardView.isUserInteractionEnabled = true
            sidebarHost.view.isUserInteractionEnabled = isOpen
            edgeStrip.isHidden = true
            closeArea.isHidden = true
            return
        }
        guard dragStart == nil else { return }
        let settled = animator == nil
        let closed = settled && progress <= 0.001
        let open = settled && progress >= 0.999
        cardView.isUserInteractionEnabled = closed
        cardView.accessibilityElementsHidden = !closed
        sidebarHost.view.isUserInteractionEnabled = open
        sidebarHost.view.accessibilityElementsHidden = !open
        edgeStrip.isHidden = !closed
        closeArea.isHidden = closed
        // The card is concentric with the display while it is away from the edge, square when it covers the screen.
        setCardRadius(closed ? 0 : displayRadius)
    }

    /// The display's corner radius, used while the card is away from the edge (the card is moved by a transform, so a
    /// container-concentric radius would resolve against its moved position and come out square).
    private var displayRadius: CGFloat {
        let radius = view.window?.effectiveRadius(corner: .topLeft) ?? 0
        return radius > 0 ? radius : 44
    }

    private var cardRadius: CGFloat = 0

    private func setCardRadius(_ radius: CGFloat) {
        guard radius != cardRadius else { return }
        cardRadius = radius
        applyCardRadius()
    }

    /// Rounds the card: its clip, its stroke and its shadow.
    ///
    /// The clip is a plain `CALayer` corner mask (`cornerRadius` + continuous curve + `masksToBounds`) rather than
    /// UIKit's `cornerConfiguration`: see README「抽屉卡片的圆角裁剪」. `AA_POC_CARD_CLIP=config|mask` switches to the
    /// other two candidates for comparison.
    private func applyCardRadius() {
        let radius = cardRadius
        let bounds = cardClip.bounds
        switch DebugLaunch.cardClip {
        case "config":
            cardClip.cornerConfiguration = .corners(radius: .fixed(radius))
        case "mask":
            if radius > 0 {
                let mask = (cardClip.layer.mask as? CAShapeLayer) ?? CAShapeLayer()
                mask.frame = bounds
                mask.path = UIBezierPath(roundedRect: bounds, cornerRadius: radius).cgPath
                cardClip.layer.mask = mask
            } else {
                cardClip.layer.mask = nil
            }
        default:
            cardClip.layer.cornerCurve = .continuous
            cardClip.layer.cornerRadius = radius
            cardClip.layer.masksToBounds = true
        }
        cardStroke.layer.cornerCurve = .continuous
        cardStroke.layer.cornerRadius = radius
        cardShadow.layer.shadowPath = UIBezierPath(roundedRect: cardShadow.bounds, cornerRadius: radius).cgPath
    }

    private func updateColors() {
        cardStroke.layer.borderColor = UIColor.label.withAlphaComponent(0.2).resolvedColor(with: traitCollection).cgColor
    }

    // MARK: Gestures

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer, !isSplit else { return false }
        let velocity = pan.velocity(in: view)
        guard abs(velocity.x) > abs(velocity.y) else { return false }
        // The edge strip only opens; the visible card strip only closes (or moves the drawer back and forth).
        return pan.view === edgeStrip ? velocity.x > 0 : true
    }

    @objc private func pan(_ recognizer: UIPanGestureRecognizer) {
        let translation = recognizer.translation(in: view).x
        let velocity = recognizer.velocity(in: view).x
        switch recognizer.state {
        case .began:
            if let animator {
                animator.stopAnimation(true)
                self.animator = nil
                progress = cardView.transform.tx / revealWidth
            }
            dragStart = progress
            cardView.isUserInteractionEnabled = false
            sidebarHost.view.isUserInteractionEnabled = false
            setCardRadius(displayRadius)
        case .changed:
            guard let dragStart else { return }
            progress = min(max(dragStart + translation / revealWidth, 0), 1)
            apply(progress)
        case .ended, .cancelled, .failed:
            guard let dragStart else { return }
            self.dragStart = nil
            let projected = dragStart + (translation + velocity * 0.2) / revealWidth
            let target: CGFloat = recognizer.state == .ended ? (projected >= 0.5 ? 1 : 0) : (progress >= 0.5 ? 1 : 0)
            settle(to: target, velocity: velocity / revealWidth, feedback: recognizer.state == .ended, animated: true)
        default:
            break
        }
    }

    @objc private func closeTapped() {
        guard progress > 0.001, dragStart == nil else { return }
        settle(to: 0, velocity: 0, feedback: true, animated: true)
    }

    private func settle(to target: CGFloat, velocity: CGFloat, feedback: Bool, animated: Bool) {
        animator?.stopAnimation(true)
        animator = nil
        if feedback, abs(progress - target) > 0.001 { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
        let remaining = target - progress
        progress = target
        isOpen = target >= 1
        guard animated, !UIAccessibility.isReduceMotionEnabled, abs(remaining) > 0.001 else {
            apply(target)
            updateInteraction()
            return
        }
        cardView.isUserInteractionEnabled = false
        sidebarHost.view.isUserInteractionEnabled = false
        setCardRadius(displayRadius)
        let initial = min(max(velocity / remaining, -8), 8)
        let timing = UISpringTimingParameters(duration: 0.34, bounce: 0.1, initialVelocity: CGVector(dx: initial, dy: 0))
        let animator = UIViewPropertyAnimator(duration: 0.34, timingParameters: timing)
        animator.addAnimations { self.apply(target) }
        animator.addCompletion { [weak self] _ in
            guard let self, self.animator === animator else { return }
            self.animator = nil
            self.updateInteraction()
        }
        self.animator = animator
        animator.startAnimation()
    }

    // MARK: Start-up

    private func startSession() {
        let first = DebugLaunch.session
            ?? controller.workspace.sessions.first { $0.state == "running" }?.id
            ?? controller.workspace.sessions.first?.id
        if let first { controller.select(first) }
        let switches = DebugLaunch.switches
        guard !switches.isEmpty else { return }
        Task { [weak self] in
            var elapsed = 0.0
            for (id, at) in switches {
                try? await Task.sleep(for: .seconds(max(0, at - elapsed)))
                elapsed = at
                LaunchClock.mark("debug switch to \(id)")
                self?.open(id)
            }
        }
    }
}

@MainActor @Observable final class SidebarInsets {
    var value = EdgeInsets()
}

/// The sidebar column: the session list under its header bar, padded by the window's safe area (passed in, since the
/// column draws under the status bar and home indicator).
struct SidebarColumn: View {
    let controller: SessionController
    let insets: SidebarInsets
    let onOpenSession: (String) -> Void

    var body: some View {
        SidebarView(controller: controller, safeAreaInsets: insets.value, onOpenSession: onOpenSession)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .scrollEdgeEffectStyle(.soft, for: .top)
            .safeAreaBar(edge: .top, spacing: 0) {
                ChatSidebarHeaderView()
                    .padding(.top, insets.value.top)
                    .padding(.leading, insets.value.leading)
                    .padding(.trailing, insets.value.trailing)
                    .frame(maxWidth: .infinity)
            }
            .background(Color(uiColor: .systemBackground))
    }
}
