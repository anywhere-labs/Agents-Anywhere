import Foundation

extension StructuredText {
  struct TableContent {
    let rows: [[AttributedString]]

    init(content: AttributedSubstring, intent: PresentationIntent.IntentType?, columnCount: Int) {
      rows = content.blockRuns(parent: intent).map { row in
        let rowContent = content[row.range]
        var cells = Array(repeating: AttributedString(), count: columnCount)
        for cell in rowContent.blockRuns(parent: row.intent) {
          guard case .tableCell(let column) = cell.intent?.kind,
            cells.indices.contains(column)
          else { continue }
          cells[column] = AttributedString(rowContent[cell.range])
        }
        return cells
      }
    }
  }
}
