import SwiftUI

/// Measures and places Textual with the same column width in one layout pass.
/// No geometry callback writes into View state or schedules a second layout.
struct MarkdownBlockLayout: Layout {
    let dynamicType: DynamicTypeSize
    let displayScale: CGFloat
    let direction: LayoutDirection

    struct Cache {
        var dynamicType: DynamicTypeSize
        var displayScale: CGFloat
        var direction: LayoutDirection
        var sizing = MarkdownBlockSizing()
    }

    func makeCache(subviews: Subviews) -> Cache {
        Cache(dynamicType: dynamicType, displayScale: displayScale, direction: direction)
    }

    func updateCache(_ cache: inout Cache, subviews: Subviews) {
        if cache.dynamicType != dynamicType || cache.displayScale != displayScale || cache.direction != direction {
            cache = makeCache(subviews: subviews)
        }
        // Appends and Textual's asynchronous highlighter/attachment updates
        // retain the last real height. Authoritative replacements recreate the
        // enclosing row's layout generation, and therefore this cache as well.
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        guard let content = subviews.first else { return .zero }
        let width = proposal.width.flatMap { $0.isFinite ? max(0, $0) : nil }
        let natural = content.sizeThatFits(.init(width: width, height: nil))
        return cache.sizing.size(proposedWidth: width, naturalSize: natural, displayScale: displayScale)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        subviews.first?.place(at: bounds.origin, anchor: .topLeading,
            proposal: .init(width: bounds.width, height: nil))
    }
}
