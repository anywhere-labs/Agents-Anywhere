import SwiftUI
import Foundation

extension EnvironmentValues {
    @Entry var streamingGlyphAnimation = false
    /// The clock stops here even while the reply streams. Streamed Markdown
    /// moves it forward whenever a block's text changes.
    @Entry var streamingRevealDeadline = Date.distantFuture
}

/// Known copy can reserve its final centered layout while phrases become
/// visible. Ordinary streamed Markdown has no phrase attributes or limit.
nonisolated struct StreamingTextPhrase: TextAttribute {
    let index: Int

    /// `underlined` marks a tappable name. Its characters keep the underline
    /// even when a phrase boundary splits them.
    @MainActor static func text(_ value: String, underlined: Range<String.Index>? = nil) -> Text {
        let phrases = TextPhraseSequence.chunks(in: value)
        var interpolation = LocalizedStringKey.StringInterpolation(literalCapacity: 0, interpolationCount: phrases.count)
        var start = value.startIndex
        for (index, phrase) in phrases.enumerated() {
            let end = value.index(start, offsetBy: phrase.count)
            var text = Text(verbatim: phrase)
            if let underlined, underlined.overlaps(start..<end) {
                let lower = max(underlined.lowerBound, start), upper = min(underlined.upperBound, end)
                text = Text(verbatim: String(value[start..<lower]))
                    + Text(verbatim: String(value[lower..<upper])).underline()
                    + Text(verbatim: String(value[upper..<end]))
            }
            interpolation.appendInterpolation(text.customAttribute(Self(index: index)))
            start = end
        }
        return Text(LocalizedStringKey(stringInterpolation: interpolation))
    }
}

/// The clock updates drawing only. It never appends text, reparses Markdown or
/// animates a layout constraint. Each paragraph/code fragment owns its ledger.
struct StreamingGlyphReveal: ViewModifier {
    @Environment(\.streamingGlyphAnimation) private var isStreaming
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.streamingRevealDeadline) private var deadline
    @State private var ledger: GlyphRevealLedger
    @State private var stoppedDeadline: Date?
    private let revealedPhraseCount: Int?

    init(ledger: GlyphRevealLedger = GlyphRevealLedger(), revealedPhraseCount: Int? = nil) {
        _ledger = State(initialValue: ledger)
        self.revealedPhraseCount = revealedPhraseCount
    }

    func body(content: Content) -> some View {
        let enabled = isStreaming && !reduceMotion
        // Text arrives in batches, one after the previous reveal ends. Drawing
        // interpolates each batch without reparsing or appending text.
        if !enabled && revealedPhraseCount == nil {
            // Settled history uses native Text drawing with no clock or glyph walk.
            content
        } else {
            // Every running clock re-evaluates its text each frame, so an idle
            // block pauses and draws its glyphs settled. 60 fps is enough for a
            // 0.24 s fade and halves the work on 120 Hz displays.
            let running = enabled && stoppedDeadline != deadline && deadline > .now
            TimelineView(.animation(minimumInterval: 1 / 60, paused: !running)) { timeline in
                content.textRenderer(GlyphRevealRenderer(ledger: ledger, now: timeline.date.timeIntervalSinceReferenceDate,
                    enabled: running, revealedPhraseCount: revealedPhraseCount))
            }
            .task(id: deadline) {
                let delay = deadline.timeIntervalSinceNow
                guard delay > 0, delay < 60 else { return }
                do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                stoppedDeadline = deadline
            }
        }
    }

}

nonisolated struct GlyphRevealRenderer: TextRenderer {
    let ledger: GlyphRevealLedger
    let now: TimeInterval
    let enabled: Bool
    var revealedPhraseCount: Int? = nil

    // Extend raster bounds for the blur and slight rise, not layout bounds.
    var displayPadding: EdgeInsets { .init(top: 6, leading: 6, bottom: 9, trailing: 6) }

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        let count = layout.reduce(0) { total, line in
            total + line.reduce(0) { $0 + (isRevealed($1) ? $1.count : 0) }
        }
        let progress = ledger.progress(count: count, now: now, enabled: enabled)
        if progress == nil {
            for line in layout {
                if line.allSatisfy(isRevealed) { context.draw(line) }
                else {
                    for run in line where isRevealed(run) { context.draw(run) }
                }
            }
            return
        }
        guard let progress else { return }
        // Glyphs from one flush share a birth time and so share one effect.
        // Settled text keeps the system's line/run drawing; only the revealing
        // suffix is split into per-batch slices. Each batch rasterizes into one
        // layer with one blur, instead of an offscreen blur per glyph.
        let batches = progress.batches
        var slices = [[Text.Layout.RunSlice]](repeating: [], count: batches.count)
        var index = 0
        var batch = 0
        for line in layout {
            let lineCount = line.reduce(0) { $0 + (isRevealed($1) ? $1.count : 0) }
            if index + lineCount <= progress.settledCount && line.allSatisfy(isRevealed) {
                context.draw(line)
                index += lineCount
                continue
            }
            for run in line where isRevealed(run) {
                let settled = min(run.count, max(0, progress.settledCount - index))
                if settled == run.count { context.draw(run) } else if settled > 0 { context.draw(run[0..<settled]) }
                var start = settled
                while start < run.count {
                    while batch < batches.count && batches[batch].range.upperBound <= index + start { batch += 1 }
                    guard batch < batches.count else { context.draw(run[start..<run.count]); break }
                    let end = min(run.count, batches[batch].range.upperBound - index)
                    slices[batch].append(run[start..<end])
                    start = end
                }
                index += run.count
            }
        }
        for (batch, batchSlices) in zip(batches, slices) where !batchSlices.isEmpty {
            var copy = context
            let effect = GlyphRevealEffect(progress: batch.progress)
            copy.opacity *= effect.opacity
            copy.translateBy(x: 0, y: effect.offsetY)
            copy.addFilter(.blur(radius: effect.blurRadius))
            copy.drawLayer { layer in
                for slice in batchSlices { layer.draw(slice, options: .disablesSubpixelQuantization) }
            }
        }
    }

    private func isRevealed(_ run: Text.Layout.Run) -> Bool {
        guard let revealedPhraseCount, let phrase = run[StreamingTextPhrase.self] else { return true }
        return phrase.index < revealedPhraseCount
    }
}
