import Foundation

/// Split the parser's actual block tree, not blank lines or regular expressions.
/// A fenced code block, nested list, table or quote stays one structural unit.
nonisolated struct MarkdownBlockSnapshot: Identifiable, Equatable {
    let id: Int
    var content: AttributedString

    static func split(_ document: AttributedString) -> [Self] {
        var blocks: [Self] = []
        for run in document.runs {
            let identity = run.presentationIntent?.components.last?.identity ?? -1
            let fragment = AttributedString(document[run.range])
            if blocks.last?.id == identity {
                blocks[blocks.count - 1].content += fragment
            } else {
                blocks.append(Self(id: identity, content: fragment))
            }
        }
        return blocks
    }
}
