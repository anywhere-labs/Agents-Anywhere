import SwiftUI

struct NewSessionWelcomeView: View {
    private static let revealDuration = 0.4
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.sidebarDrawerIsTransitioning) private var sidebarIsTransitioning
    @Environment(\.sidebarDrawerObscuresDetail) private var sidebarObscuresDetail
    @ScaledMetric(relativeTo: .largeTitle) private var titleSize: CGFloat = 40
    @State private var copy = NewSessionWelcomeCopy.allCases.randomElement() ?? .start
    @State private var displayedTitle = ""
    @State private var displayedDetail = ""
    @State private var hasStarted = false
    @State private var isRevealing = false
    @State private var titleLedger = GlyphRevealLedger(duration: NewSessionWelcomeView.revealDuration)
    @State private var detailLedger = GlyphRevealLedger(duration: NewSessionWelcomeView.revealDuration)

    private var canReveal: Bool { !sidebarIsTransitioning && !sidebarObscuresDetail }
    private var title: String { String(localized: copy.title) }
    private var detail: String { String(localized: copy.detail) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            AppSymbol("sparkles", size: 28).foregroundStyle(.primary)
            streamingText(title, displayed: displayedTitle, ledger: titleLedger)
                .font(.system(size: titleSize, weight: .bold))
                .accessibilityAddTraits(.isHeader)
            streamingText(detail, displayed: displayedDetail, ledger: detailLedger)
                .font(.body).foregroundStyle(.secondary)
        }
        .task(id: [canReveal, reduceMotion]) { await reveal() }
    }

    private func streamingText(_ text: String, displayed: String, ledger: GlyphRevealLedger) -> some View {
        // The full copy determines layout; only the overlay receives phrases.
        // It uses exactly the same glyph renderer as streamed Agent messages.
        Text(verbatim: text)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .hidden()
            .overlay(alignment: .topLeading) {
                Text(verbatim: displayed)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .modifier(StreamingGlyphReveal(ledger: ledger))
                    .environment(\.streamingGlyphAnimation, isRevealing)
            }
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
            displayedTitle = title
            displayedDetail = detail
            isRevealing = false
        }
        guard !reduceMotion else { return }
        var schedule = ReplyFlushSchedule(start: .now)
        do {
            for phrase in TextPhraseSequence.chunks(in: title) {
                try Task.checkCancellation()
                displayedTitle += phrase
                try await Task.sleep(until: schedule.deadline, clock: .continuous)
                schedule.advance(after: .now)
            }
            for phrase in TextPhraseSequence.chunks(in: detail) {
                try Task.checkCancellation()
                displayedDetail += phrase
                try await Task.sleep(until: schedule.deadline, clock: .continuous)
                schedule.advance(after: .now)
            }
            try await Task.sleep(for: .seconds(Self.revealDuration + 2 / ReplyPresentation.flushesPerSecond))
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
        case .start: "从这里开始"
        case .idea: "把想法变成进展"
        case .question: "今天，做点什么？"
        case .nextStep: "让下一步更简单"
        case .explore: "一个想法，就够了"
        case .together: "准备好，一起开工"
        }
    }

    var detail: LocalizedStringResource {
        switch self {
        case .start: "选择设备和 Agent，把想做的事交给它。"
        case .idea: "修一个问题，做一个功能，或探索新的方向。"
        case .question: "从一个问题开始，让 Agent 和你一起找到答案。"
        case .nextStep: "描述你的目标，其余的可以一步步来。"
        case .explore: "写下想做的事，和 Agent 一起把细节补全。"
        case .together: "选择熟悉的设备和工具，开始下一件想做的事。"
        }
    }
}
