import SwiftUI
import Textual

/// Uses the same range selection as Markdown without interpreting user input or
/// tool output as markup. SwiftUI Text's copy menu selects the entire value on iOS.
struct ChatSelectableText: View {
    let text: String

    var body: some View {
        InlineText(text, parser: LiteralTextParser())
            .textual.textSelection(.enabled)
    }
}

private struct LiteralTextParser: MarkupParser {
    func attributedString(for input: String) throws -> AttributedString {
        AttributedString(input)
    }
}
