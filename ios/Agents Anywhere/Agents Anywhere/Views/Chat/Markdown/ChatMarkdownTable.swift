import SwiftUI
import Textual

struct ChatMarkdownTable: View {
    let rows: [[AttributedString]]
    let columns: [PresentationIntent.TableColumn]

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                ForEach(rows.indices, id: \.self) { row in
                    GridRow {
                        ForEach(rows[row].indices, id: \.self) { column in
                            cell(rows[row][column], header: row == 0, column: column)
                                .gridColumnAlignment(alignment(column))
                        }
                    }
                    if row != rows.indices.last {
                        Divider().gridCellColumns(max(1, columns.count)).gridCellUnsizedAxes(.horizontal)
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

    private func cell(_ content: AttributedString, header: Bool, column: Int) -> some View {
        InlineText(String(content.hashValue), parser: ParsedMarkdownText(content: content))
            .textual.textSelection(.enabled)
            .modifier(StreamingGlyphReveal())
            .fontWeight(header ? .semibold : .regular)
            .frame(minWidth: 80, maxWidth: 280, alignment: Alignment(horizontal: alignment(column), vertical: .top))
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 12).padding(.vertical, 10)
            .frame(maxHeight: .infinity, alignment: .top)
            .background(header ? Color.primary.opacity(0.04) : .clear)
            .overlay(alignment: .trailing) {
                if column < columns.count - 1 {
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
