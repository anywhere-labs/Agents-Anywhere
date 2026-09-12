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
        // Text flushes at 30 Hz. Drawing can use the display's refresh cadence
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
        var index = 0
        for line in layout {
            for run in line where isRevealed(run) {
                guard let progress else { context.draw(run); continue }
                // Already settled runs keep the system's efficient drawing path.
                if progress[index..<(index + run.count)].allSatisfy({ $0 >= 1 }) {
                    context.draw(run)
                    index += run.count
                } else {
                    for glyph in run {
                        var copy = context
                        let effect = GlyphRevealEffect(progress: progress[index])
                        copy.opacity *= effect.opacity
                        copy.translateBy(x: 0, y: effect.offsetY)
                        copy.addFilter(.blur(radius: effect.blurRadius))
                        copy.draw(glyph, options: .disablesSubpixelQuantization)
                        index += 1
                    }
                }
            }
        }
    }

    private func isRevealed(_ run: Text.Layout.Run) -> Bool {
        guard let revealedPhraseCount, let phrase = run[StreamingTextPhrase.self] else { return true }
        return phrase.index < revealedPhraseCount
    }
}
