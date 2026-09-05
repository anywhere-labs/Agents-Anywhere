import SwiftUI
import Foundation

extension EnvironmentValues {
    @Entry var streamingGlyphAnimation = false
}

/// The clock updates drawing only. It never appends text, reparses Markdown or
/// animates a layout constraint. Each paragraph/code fragment owns its ledger.
struct StreamingGlyphReveal: ViewModifier {
    @Environment(\.streamingGlyphAnimation) private var isStreaming
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var ledger: GlyphRevealLedger

    init(ledger: GlyphRevealLedger = GlyphRevealLedger()) {
        _ledger = State(initialValue: ledger)
    }

    func body(content: Content) -> some View {
        let enabled = isStreaming && !reduceMotion
        // Text flushes at 30 Hz. Drawing can use the display's refresh cadence
        // to interpolate between flushes without reparsing or appending text.
        TimelineView(.animation(paused: !enabled)) { timeline in
            content.textRenderer(GlyphRevealRenderer(ledger: ledger, now: timeline.date.timeIntervalSinceReferenceDate, enabled: enabled))
        }
    }

}

nonisolated private struct GlyphRevealRenderer: TextRenderer {
    let ledger: GlyphRevealLedger
    let now: TimeInterval
    let enabled: Bool

    // Extend raster bounds for the blur and slight rise, not layout bounds.
    var displayPadding: EdgeInsets { .init(top: 6, leading: 6, bottom: 9, trailing: 6) }

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        let count = layout.reduce(0) { total, line in total + line.reduce(0) { $0 + $1.count } }
        guard let progress = ledger.progress(count: count, now: now, enabled: enabled) else {
            for line in layout { context.draw(line) }
            return
        }
        var index = 0
        for line in layout {
            for run in line {
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
}
