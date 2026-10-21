import Foundation

/// Split the parser's actual block tree, not blank lines or regular expressions.
/// A fenced code block, nested list, table or quote stays one structural unit.
nonisolated struct MarkdownBlockSnapshot: Identifiable, Equatable {
    let id: Int
    let content: AttributedString
    /// Hashed on the parse worker. Every flush compares all blocks on the main
    /// actor, and a character-wise AttributedString comparison grows with the reply.
    let digest: Int

    init(id: Int, content: AttributedString) {
        self.id = id
        self.content = content
        digest = content.hashValue
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id && lhs.digest == rhs.digest
    }

    static func split(_ document: AttributedString) -> [Self] {
        var parts: [(id: Int, content: AttributedString)] = []
        for run in document.runs {
            let identity = run.presentationIntent?.components.last?.identity ?? -1
            let fragment = AttributedString(document[run.range])
            if parts.last?.id == identity {
                parts[parts.count - 1].content += fragment
            } else {
                parts.append((identity, fragment))
            }
        }
        return parts.map { Self(id: $0.id, content: $0.content) }
    }

    /// Re-identify blocks sequentially from `startID`, in document order.
    static func split(_ document: AttributedString, startingAt startID: Int) -> [Self] {
        split(document).enumerated().map { Self(id: startID + $0.offset, content: $0.element.content) }
    }
}
