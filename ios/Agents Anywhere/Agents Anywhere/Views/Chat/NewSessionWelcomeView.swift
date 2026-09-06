import SwiftUI

struct NewSessionWelcomeView: View {
    private static let revealDuration = 0.4
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.sidebarDrawerIsTransitioning) private var sidebarIsTransitioning
    @Environment(\.sidebarDrawerObscuresDetail) private var sidebarObscuresDetail
    @ScaledMetric(relativeTo: .largeTitle) private var titleSize: CGFloat = 40
    @State private var copy = NewSessionWelcomeCopy.allCases.randomElement() ?? .start
    @State private var titlePhraseCount = 0
    @State private var detailPhraseCount = 0
    @State private var hasStarted = false
    @State private var isRevealing = false
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
        .task(id: [canReveal, reduceMotion]) { await reveal() }
        .sensoryFeedback(.impact(weight: .light, intensity: 0.6), trigger: revealCompletion)
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
        guard canReveal, !hasStarted else { return }
        if !reduceMotion {
            do { try await Task.sleep(for: .milliseconds(60)) }
            catch { return }
        }
        guard !Task.isCancelled else { return }
        hasStarted = true
        isRevealing = !reduceMotion
        // Cancellation, leaving the page, and Reduce Motion always settle the
        // complete copy. They cannot leave a partial heading or an active clock.
        defer {
            titlePhraseCount = TextPhraseSequence.chunks(in: title).count
            detailPhraseCount = TextPhraseSequence.chunks(in: detail).count
            isRevealing = false
        }
        guard !reduceMotion else { revealCompletion += 1; return }
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
