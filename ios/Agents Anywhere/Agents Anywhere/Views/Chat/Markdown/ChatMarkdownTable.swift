import SwiftUI
import Textual

struct ChatMarkdownTable: View {
    let rows: [[AttributedString]]
    let columns: [PresentationIntent.TableColumn]
    // The horizontal scroll view proposes nil width to its content, so the
    // grid cannot learn the viewport from layout proposals. This published
    // width (read from the scroll view's own frame) is the only source.
    @State private var viewportWidth: CGFloat?

    var body: some View {
        let columnCount = max(1, rows.map(\.count).max() ?? 0)
        ScrollView(.horizontal) {
            TableGridLayout(columns: columnCount, minWidth: 76, maxWidth: 260, viewportWidth: viewportWidth) {
                ForEach(rows.indices, id: \.self) { row in
                    ForEach(0..<columnCount, id: \.self) { column in
                        cell(rows[row].indices.contains(column) ? rows[row][column] : AttributedString(),
                             row: row, column: column, columnCount: columnCount)
                    }
                }
            }
            // The frame hugs the grid, so a narrow table has no empty panel
            // beside it and a wide one scrolls with its border.
            .background(Color(uiColor: .secondarySystemBackground))
            .clipShape(.rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(.primary.opacity(0.12), lineWidth: 0.5).allowsHitTesting(false))
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: {
            // Ignore tiny probe widths from parent measurement passes.
            if $0 > 1 { viewportWidth = $0 }
        }
    }

    private func cell(_ content: AttributedString, row: Int, column: Int, columnCount: Int) -> some View {
        InlineText(String(content.hashValue), parser: ParsedMarkdownText(content: content))
            .textual.textSelection(.enabled)
            .modifier(StreamingGlyphReveal())
            .fontWeight(row == 0 ? .semibold : .regular)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: Alignment(horizontal: alignment(column), vertical: .top))
            .background(row == 0 ? Color.primary.opacity(0.04) : .clear)
            .overlay(alignment: .trailing) {
                if column < columnCount - 1 {
                    Rectangle().fill(.primary.opacity(0.12)).frame(width: 0.5).allowsHitTesting(false)
                }
            }
            .overlay(alignment: .bottom) {
                if row < rows.count - 1 {
                    Rectangle().fill(.primary.opacity(0.12)).frame(height: 0.5).allowsHitTesting(false)
                }
            }
    }

    private func alignment(_ column: Int) -> HorizontalAlignment {
        guard columns.indices.contains(column) else { return .leading }
        return switch columns[column].alignment {
        case .left: .leading
        case .center: .center
        case .right: .trailing
        @unknown default: .leading
        }
    }
}

/// Grid measured its rows under a different width than it placed them with
/// inside the horizontal scroll view, so wrapped cells overflowed into the
/// next row and the table was cut short. This layout sizes each column once
/// (ideal width, capped so long cells wrap), gives every row its tallest
/// cell's height and places cells with exactly that size. When the grid is
/// narrower than its container, the surplus is shared across the columns so
/// short-content tables (CJK cells especially) use the available width
/// instead of wrapping inside minimal columns.
private struct TableGridLayout: Layout {
    let columns: Int
    let minWidth: CGFloat
    let maxWidth: CGFloat
    /// Published viewport width: layout proposals inside a horizontal scroll
    /// view carry no width at all, so this state is the grid's only source.
    let viewportWidth: CGFloat?

    struct Metrics {
        var widths: [CGFloat] = []
        var heights: [CGFloat] = []
    }

    func makeCache(subviews: Subviews) -> Metrics? { nil }

    func updateCache(_ cache: inout Metrics?, subviews: Subviews) { cache = nil }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Metrics?) -> CGSize {
        let metrics = measure(subviews, available: viewportWidth, cache: &cache)
        return CGSize(width: metrics.widths.reduce(0, +), height: metrics.heights.reduce(0, +))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Metrics?) {
        let metrics = measure(subviews, available: viewportWidth, cache: &cache)
        var y = bounds.minY
        for (row, height) in metrics.heights.enumerated() {
            var x = bounds.minX
            for (column, width) in metrics.widths.enumerated() {
                let index = row * columns + column
                guard subviews.indices.contains(index) else { break }
                subviews[index].place(at: CGPoint(x: x, y: y), anchor: .topLeading,
                                      proposal: ProposedViewSize(width: width, height: height))
                x += width
            }
            y += height
        }
    }

    private func measure(_ subviews: Subviews, available: CGFloat?, cache: inout Metrics?) -> Metrics {
        if let cache { return cache }
        let rowCount = (subviews.count + columns - 1) / columns
        // On a narrow viewport (foldable cover screen) the static cap keeps a
        // two-column table wider than the screen, so cells never get squeezed
        // into wrapping and the table just scrolls instead. Shrink the cap to
        // the viewport's equal share (never below minWidth) so narrow screens
        // compress columns and wrap; wide screens keep the full cap.
        var columnMaxWidth = maxWidth
        if let available, available.isFinite, available > 0 {
            columnMaxWidth = min(maxWidth, max(minWidth, available / CGFloat(columns)))
        }
        var metrics = Metrics(widths: Array(repeating: minWidth, count: columns))
        for (index, subview) in subviews.enumerated() {
            let ideal = subview.sizeThatFits(.unspecified).width
            metrics.widths[index % columns] = min(max(metrics.widths[index % columns], ideal), columnMaxWidth)
        }
        // Share the container's surplus across the columns. No cap here:
        // the per-column cap above already bounds a column on screens where
        // the table scrolls; once the table fits its container, letting
        // long-text columns take their share is exactly what stops them
        // wrapping hard (a two-column step/result table on a phone). Equal
        // shares keep the total within the container.
        if let available, available.isFinite, available > 0 {
            let total = metrics.widths.reduce(0, +)
            if total < available {
                let extra = (available - total) / CGFloat(columns)
                metrics.widths = metrics.widths.map { $0 + extra }
            }
        }
        metrics.heights = (0..<rowCount).map { row in
            (0..<columns).reduce(0) { tallest, column in
                let index = row * columns + column
                guard subviews.indices.contains(index) else { return tallest }
                let width = metrics.widths[column]
                return max(tallest, subviews[index].sizeThatFits(ProposedViewSize(width: width, height: nil)).height)
            }
        }
        cache = metrics
        return metrics
    }
}

struct ParsedMarkdownText: MarkupParser {
    let content: AttributedString
    func attributedString(for input: String) throws -> AttributedString { content }
}
