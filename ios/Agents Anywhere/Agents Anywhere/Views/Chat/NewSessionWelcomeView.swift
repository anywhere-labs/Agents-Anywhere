import SwiftUI

struct NewSessionWelcomeView<Workspace: View>: View {
    @ViewBuilder let workspace: () -> Workspace
    private static var revealDuration: Double { 0.4 }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.sidebarDrawerIsTransitioning) private var sidebarIsTransitioning
    @Environment(\.sidebarDrawerObscuresDetail) private var sidebarObscuresDetail
    @ScaledMetric(relativeTo: .largeTitle) private var titleSize: CGFloat = 40
    @State private var copy = NewSessionWelcomeCopy.allCases.randomElement() ?? .start
    @State private var titlePhraseCount = 0
    @State private var detailPhraseCount = 0
    @State private var hasStarted = false
    @State private var initialFrame = CGRect.zero
    @State private var isRevealing = false
    @State private var workspaceRevealed = false
    @State private var revealCompletion = 0
    @State private var titleLedger = GlyphRevealLedger(duration: NewSessionWelcomeView.revealDuration)
    @State private var detailLedger = GlyphRevealLedger(duration: NewSessionWelcomeView.revealDuration)

    private var canReveal: Bool { !sidebarIsTransitioning && !sidebarObscuresDetail }
    private var title: String { String(localized: copy.title) }
    private var detail: String {
        [String(localized: "dashboard.new.typewriter.rightDevice"),
         String(localized: "dashboard.new.typewriter.focusedSession")].joined(separator: "\n")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            welcomeText
            workspace()
                .modifier(WelcomeWorkspaceReveal(progress: workspaceRevealed ? 1 : 0))
                .allowsHitTesting(workspaceRevealed)
                .accessibilityHidden(!workspaceRevealed)
        }
        .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { frame in
            // Observe real layout without locking its width or height. Once
            // drawing begins, geometry updates must not cancel the reveal task.
            if !hasStarted { initialFrame = frame }
        }
        .task(id: WelcomeRevealKey(canReveal: canReveal, reduceMotion: reduceMotion, frame: initialFrame)) { await reveal() }
        .completionFeedback(trigger: revealCompletion)
    }

    private var welcomeText: some View {
        VStack(alignment: .leading, spacing: 12) {
            AppSymbol("sparkles", size: 28).foregroundStyle(.primary)
            streamingText(title, revealedPhrases: titlePhraseCount, ledger: titleLedger)
                .font(.system(size: titleSize, weight: .bold))
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                .minimumScaleFactor(dynamicTypeSize.isAccessibilitySize ? 1 : 0.65)
                .accessibilityAddTraits(.isHeader)
            streamingText(detail, revealedPhrases: detailPhraseCount, ledger: detailLedger)
                .font(.body).foregroundStyle(.secondary)
                .lineLimit(2...)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func streamingText(_ text: String, revealedPhrases: Int, ledger: GlyphRevealLedger) -> some View {
        // Future phrases take part in line breaking from the first
        // frame. The shared renderer alone controls their visibility and reveal.
        StreamingTextPhrase.text(text)
            .modifier(StreamingGlyphReveal(ledger: ledger, revealedPhraseCount: revealedPhrases))
            .environment(\.streamingGlyphAnimation, isRevealing)
            .multilineTextAlignment(.leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(text)
    }

    private func reveal() async {
        guard canReveal, !hasStarted, initialFrame.width > 0, initialFrame.height > 0 else { return }
        if !reduceMotion {
            // Navigation chrome, composer sizing and the cached workspace get
            // their first layout before glyphs appear. A changing frame restarts
            // this quiet interval; no network request gates the welcome.
            do { try await Task.sleep(for: .milliseconds(120)) }
            catch { return }
        }
        guard !Task.isCancelled else { return }
        hasStarted = true
        isRevealing = !reduceMotion
        // Cancellation, leaving the page, and Reduce Motion always settle the
        // complete copy. They cannot leave a partial heading or an active clock.
        defer {
            var transaction = Transaction(animation: nil)
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                titlePhraseCount = TextPhraseSequence.chunks(in: title).count
                detailPhraseCount = TextPhraseSequence.chunks(in: detail).count
                workspaceRevealed = true
                isRevealing = false
            }
        }
        guard !reduceMotion else { revealCompletion += 1; return }
        // Match the glyph ledger's cubic ease-out. Keep the picker in layout
        // from frame one; only drawing changes during the welcome animation.
        withAnimation(.timingCurve(1.0 / 3, 1, 2.0 / 3, 1, duration: Self.revealDuration)) {
            workspaceRevealed = true
        }
        var schedule = ReplyFlushSchedule(start: .now)
        do {
            for count in TextPhraseSequence.chunks(in: title).indices {
                try Task.checkCancellation()
                titlePhraseCount = count + 1
                try await Task.sleep(until: schedule.deadline, clock: .continuous)
                schedule.advance(after: .now)
            }
            for count in TextPhraseSequence.chunks(in: detail).indices {
                try Task.checkCancellation()
                detailPhraseCount = count + 1
                try await Task.sleep(until: schedule.deadline, clock: .continuous)
                schedule.advance(after: .now)
            }
            try await Task.sleep(for: .seconds(Self.revealDuration + 2 / ReplyPresentation.flushesPerSecond))
            try Task.checkCancellation()
            if canReveal { revealCompletion += 1 }
        } catch {
            // The defer completes the presentation if its lifecycle interrupts it.
        }
    }
}

private struct WelcomeRevealKey: Equatable {
    let canReveal: Bool
    let reduceMotion: Bool
    let frame: CGRect
}

private struct WelcomeWorkspaceReveal: ViewModifier, Animatable {
    var progress: Double
    var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    func body(content: Content) -> some View {
        let effect = GlyphRevealEffect(progress: progress)
        content.opacity(effect.opacity)
            .blur(radius: effect.blurRadius)
            .offset(y: effect.offsetY)
    }
}

/// Chosen once for this page presentation, independently of network updates,
/// target selection, typing, or opening and closing a sheet.
private enum NewSessionWelcomeCopy: CaseIterable {
    case start, idea, question, nextStep, explore, together

    var title: LocalizedStringResource {
        switch self {
        case .start: "dashboard.new.typewriter.buildNext"
        case .idea: "dashboard.new.typewriter.startWhere"
        case .question: "dashboard.new.typewriter.workOn"
        case .nextStep: "dashboard.new.typewriter.giveTask"
        case .explore: "dashboard.new.typewriter.startWorkspace"
        case .together: "dashboard.new.typewriter.needsAttention"
        }
    }
}
