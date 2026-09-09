import SwiftUI
import Textual

struct ChatMarkdownTable: View {
    let rows: [[AttributedString]]
    let columns: [PresentationIntent.TableColumn]

    var body: some View {
        ScrollView(.horizontal) {
            MarkdownTableLayout(columnCount: columnCount) {
                ForEach(rows.indices, id: \.self) { row in
                    ForEach(0..<columnCount, id: \.self) { column in
                        cell(rows[row].indices.contains(column) ? rows[row][column] : AttributedString(),
                             header: row == 0, column: column)
                            .overlay(alignment: .bottom) {
                                if row != rows.indices.last {
                                    Rectangle().fill(.primary.opacity(0.12)).frame(height: 0.5)
                                        .allowsHitTesting(false)
                                }
                            }
                    }
                }
            }
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .fixedSize(horizontal: false, vertical: true)
        .background(Color(uiColor: .secondarySystemBackground))
        .clipShape(.rect(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(.primary.opacity(0.12), lineWidth: 0.5).allowsHitTesting(false))
    }

    private var columnCount: Int { max(columns.count, rows.map(\.count).max() ?? 0) }

    private func cell(_ content: AttributedString, header: Bool, column: Int) -> some View {
        InlineText(String(content.hashValue), parser: ParsedMarkdownText(content: content))
            .textual.textSelection(.enabled)
            .modifier(StreamingGlyphReveal())
            .fontWeight(header ? .semibold : .regular)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 12).padding(.vertical, 10)
            .frame(maxWidth: .infinity, maxHeight: .infinity,
                   alignment: Alignment(horizontal: alignment(column), vertical: .top))
            .background(header ? Color.primary.opacity(0.04) : .clear)
            .overlay(alignment: .trailing) {
                if column < columnCount - 1 {
                    Rectangle().fill(.primary.opacity(0.12)).frame(width: 0.5).allowsHitTesting(false)
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

struct ParsedMarkdownText: MarkupParser {
    let content: AttributedString
    func attributedString(for input: String) throws -> AttributedString { content }
}

/// Resolve shared column widths before measuring wrapped cell heights. A horizontal
/// ScrollView proposes no width; flexible Grid cells can otherwise be measured at
/// a different width from the one used for placement, clipping multiline content.
private struct MarkdownTableLayout: Layout {
    let columnCount: Int

    struct Measurements {
        var widths: [CGFloat]
        var heights: [CGFloat]
        var size: CGSize {
            CGSize(width: widths.reduce(0, +), height: heights.reduce(0, +))
        }
    }

    private func measure(_ subviews: Subviews) -> Measurements {
        guard columnCount > 0, !subviews.isEmpty else {
            return Measurements(widths: [], heights: [])
        }
        var widths = Array(repeating: CGFloat(104), count: columnCount)
        for (index, cell) in subviews.enumerated() {
            let ideal = cell.sizeThatFits(.unspecified).width
            let width = ideal.isFinite ? min(304, max(104, ideal)) : 304
            widths[index % columnCount] = max(widths[index % columnCount], width)
        }
        var heights = Array(repeating: CGFloat.zero,
                            count: (subviews.count + columnCount - 1) / columnCount)
        for (index, cell) in subviews.enumerated() {
            let size = cell.sizeThatFits(.init(width: widths[index % columnCount], height: nil))
            heights[index / columnCount] = max(heights[index / columnCount], size.height)
        }
        return Measurements(widths: widths, heights: heights)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        measure(subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let measurements = measure(subviews)
        guard !measurements.widths.isEmpty else { return }
        var y = bounds.minY
        for row in measurements.heights.indices {
            var x = bounds.minX
            for column in measurements.widths.indices {
                let index = row * columnCount + column
                guard index < subviews.count else { continue }
                subviews[index].place(at: CGPoint(x: x, y: y), anchor: .topLeading,
                    proposal: .init(width: measurements.widths[column], height: measurements.heights[row]))
                x += measurements.widths[column]
            }
            y += measurements.heights[row]
        }
    }
}
