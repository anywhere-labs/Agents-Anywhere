import SwiftUI
import Foundation

extension EnvironmentValues {
    @Entry var streamingGlyphAnimation = false
}

/// Known copy can reserve its final centered layout while phrases become
/// visible. Ordinary streamed Markdown has no phrase attributes or limit.
nonisolated struct StreamingTextPhrase: TextAttribute {
    let index: Int

    @MainActor static func text(_ value: String) -> Text {
        let phrases = TextPhraseSequence.chunks(in: value)
        var interpolation = LocalizedStringKey.StringInterpolation(literalCapacity: 0, interpolationCount: phrases.count)
        for (index, phrase) in phrases.enumerated() {
            interpolation.appendInterpolation(Text(verbatim: phrase).customAttribute(Self(index: index)))
        }
        return Text(LocalizedStringKey(stringInterpolation: interpolation))
    }
}

/// The clock updates drawing only. It never appends text, reparses Markdown or
/// animates a layout constraint. Each paragraph/code fragment owns its ledger.
struct StreamingGlyphReveal: ViewModifier {
    @Environment(\.streamingGlyphAnimation) private var isStreaming
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var ledger: GlyphRevealLedger
    private let revealedPhraseCount: Int?

    init(ledger: GlyphRevealLedger = GlyphRevealLedger(), revealedPhraseCount: Int? = nil) {
        _ledger = State(initialValue: ledger)
        self.revealedPhraseCount = revealedPhraseCount
    }

    func body(content: Content) -> some View {
        let enabled = isStreaming && !reduceMotion
        // Text flushes at 5 Hz. Drawing can use the display's refresh cadence
        // to interpolate between flushes without reparsing or appending text.
        if !enabled && revealedPhraseCount == nil {
            // Settled history uses native Text drawing with no clock or glyph walk.
            content
        } else {
            TimelineView(.animation(paused: !enabled)) { timeline in
                content.textRenderer(GlyphRevealRenderer(ledger: ledger, now: timeline.date.timeIntervalSinceReferenceDate,
                    enabled: enabled, revealedPhraseCount: revealedPhraseCount))
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
        // Draw each batch with a single context instead of one per glyph, and
        // skip blur: an offscreen blur per glyph every frame saturated the
        // main thread while a reply streamed.
        var batches: [(progress: Double, slices: [Text.Layout.RunSlice])] = []
        var index = 0
        for line in layout {
            for run in line where isRevealed(run) {
                var start = 0
                while start < run.count {
                    let value = progress[index + start]
                    var end = start + 1
                    while end < run.count && progress[index + end] == value { end += 1 }
                    let slice = run[start..<end]
                    if value >= 1 {
                        // Settled glyphs keep the system's efficient drawing path.
                        context.draw(slice)
                    } else if let batch = batches.firstIndex(where: { $0.progress == value }) {
                        batches[batch].slices.append(slice)
                    } else {
                        batches.append((value, [slice]))
                    }
                    start = end
                }
                index += run.count
            }
        }
        for batch in batches {
            var copy = context
            let effect = GlyphRevealEffect(progress: batch.progress)
            copy.opacity *= effect.opacity
            copy.translateBy(x: 0, y: effect.offsetY)
            for slice in batch.slices { copy.draw(slice, options: .disablesSubpixelQuantization) }
        }
    }

    private func isRevealed(_ run: Text.Layout.Run) -> Bool {
        guard let revealedPhraseCount, let phrase = run[StreamingTextPhrase.self] else { return true }
        return phrase.index < revealedPhraseCount
    }
}
