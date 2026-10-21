import SwiftUI

/// The device is the title and the Agent leads the detail. Both names are
/// underlined and open the target picker.
struct NewSessionWelcomeView: View {
    let deviceName: String?
    let agentName: String?
    let onChooseTarget: () -> Void
    private static var revealDuration: Double { 0.4 }
    /// Known copy cascades: each phrase starts before the previous one ends.
    private static var phraseInterval: Duration { .milliseconds(200) }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .largeTitle) private var titleSize: CGFloat = 40
    @State private var copy = NewSessionWelcomeCopy.allCases.randomElement() ?? .start
    @State private var titlePhraseCount = 0
    @State private var detailPhraseCount = 0
    @State private var hasStarted = false
    @State private var initialFrame = CGRect.zero
    @State private var isRevealing = false
    @State private var revealCompletion = 0
    @State private var titleLedger = GlyphRevealLedger(duration: NewSessionWelcomeView.revealDuration)
    @State private var detailLedger = GlyphRevealLedger(duration: NewSessionWelcomeView.revealDuration)

    private var title: String { deviceName ?? String(localized: "选择设备") }
    private var agent: String { agentName ?? String(localized: "Agent") }
    private var detail: String { copy.detail(agent: agent) }

    var body: some View {
        welcomeText
        .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { frame in
            // Observe real layout without locking its width or height. Once
            // drawing begins, geometry updates must not cancel the reveal task.
            if !hasStarted { initialFrame = frame }
        }
        .sidebarDrawerSettledTask(id: WelcomeRevealKey(reduceMotion: reduceMotion, frame: initialFrame)) { settled in
            await reveal(canReveal: settled)
        }
        .completionFeedback(trigger: revealCompletion)
    }

    private var welcomeText: some View {
        VStack(alignment: .leading, spacing: 12) {
            AppSymbol("sparkles", size: 28).foregroundStyle(.primary)
            Button(action: onChooseTarget) {
                streamingText(title, underlined: title.startIndex..<title.endIndex,
                              revealedPhrases: titlePhraseCount, ledger: titleLedger)
                    .font(.system(size: titleSize, weight: .bold))
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                    .minimumScaleFactor(dynamicTypeSize.isAccessibilitySize ? 1 : 0.45)
            }
            .buttonStyle(.plain)
            // Left aligned, but kept clear of the trailing edge.
            .padding(.trailing, 24)
            .padding(.bottom, 4)
            .accessibilityAddTraits(.isHeader)
            .accessibilityHint(String(localized: "选择设备和 Agent"))
            .accessibilityIdentifier("chat.new.device")
            Button(action: onChooseTarget) {
                streamingText(detail, underlined: detail.range(of: agent),
                              revealedPhrases: detailPhraseCount, ledger: detailLedger)
                    .font(.body).foregroundStyle(.secondary)
                    .lineLimit(2...)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .buttonStyle(.plain)
            .accessibilityHint(String(localized: "选择设备和 Agent"))
            .accessibilityIdentifier("chat.new.agent")
        }
    }

    private func streamingText(_ text: String, underlined: Range<String.Index>?, revealedPhrases: Int,
                               ledger: GlyphRevealLedger) -> some View {
        // Future phrases take part in line breaking from the first
        // frame. The shared renderer alone controls their visibility and reveal.
        StreamingTextPhrase.text(text, underlined: underlined)
            .modifier(StreamingGlyphReveal(ledger: ledger, revealedPhraseCount: revealedPhrases))
            .environment(\.streamingGlyphAnimation, isRevealing)
            .multilineTextAlignment(.leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(text)
    }

    private func reveal(canReveal: Bool) async {
        guard canReveal, !hasStarted, initialFrame.width > 0, initialFrame.height > 0 else { return }
        if !reduceMotion {
            // Navigation chrome and composer sizing get
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
                // Names can arrive or change after the reveal; show all phrases.
                titlePhraseCount = .max
                detailPhraseCount = .max
                isRevealing = false
            }
        }
        guard !reduceMotion else { revealCompletion += 1; return }
        var schedule = ReplyFlushSchedule(start: .now, interval: Self.phraseInterval)
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
            try await Task.sleep(for: .seconds(Self.revealDuration + ReplyPresentation.drawSlack))
            try Task.checkCancellation()
            if canReveal { revealCompletion += 1 }
        } catch {
            // The defer completes the presentation if its lifecycle interrupts it.
        }
    }
}

private struct WelcomeRevealKey: Equatable {
    let reduceMotion: Bool
    let frame: CGRect
}

/// Chosen once for this page presentation, independently of network updates,
/// target selection, typing, or opening and closing a sheet.
private enum NewSessionWelcomeCopy: CaseIterable {
    case start, issue, nextStep, feature, review

    func detail(agent: String) -> String {
        switch self {
        case .start: String(localized: "使用 \(agent) 构建接下来的内容。")
        case .issue: String(localized: "使用 \(agent) 排查一个问题。")
        case .nextStep: String(localized: "使用 \(agent) 推进下一步。")
        case .feature: String(localized: "使用 \(agent) 实现一个新功能。")
        case .review: String(localized: "使用 \(agent) 审查最近的改动。")
        }
    }
}
