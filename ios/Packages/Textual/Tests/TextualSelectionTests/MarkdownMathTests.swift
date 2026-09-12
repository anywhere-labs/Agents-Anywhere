import Foundation
import Testing
@testable import Textual

@Suite @MainActor
struct MarkdownMathTests {
  @Test(arguments: [
    #"$x_1 + x_2$"#,
    #"\(x_1 + x_2\)"#,
    #"$$\frac{a}{b} + \{x\}$$"#,
    #"\[\begin{matrix}a & b \\ c & d\end{matrix}\]"#,
    "$$\na_1 * b_2\n+ c\n$$",
  ])
  func preservesTeXBeforeMarkdown(_ source: String) throws {
    let result = try parse(source)
    #expect(String(result.characters) == "\u{FFFC}")
    #expect(result.runs.filter { $0.textual.attachment != nil }.count == 1)
    let delimiter = source.hasPrefix("$") && !source.hasPrefix("$$") ? 1 : 2
    let latex = String(source.dropFirst(delimiter).dropLast(delimiter))
    #expect(result.runs.first?.textual.attachment?.description.contains(latex) == true)
  }

  @Test func keepsCodeEscapesAndUnfinishedMathLiteral() throws {
    for source in [#"`$x_1$`"#, "```tex\n\\[x\\]\n```", "    $x_1$", #"\$5 and \$10"#, #"\(unfinished"#, "$unfinished"] {
      let result = try parse(source)
      #expect(!result.runs.contains { $0.textual.attachment != nil })
      #expect(!String(result.characters).contains("AAMATH"))
    }
    #expect(String(try parse("    $x_1$").characters).contains("$x_1$"))
  }

  @Test func preservesSurroundingFormattingAndMultipleExpressions() throws {
    let result = try parse(#"**Before $a$ and \(b\) after**"#)
    #expect(String(result.characters) == "Before \u{FFFC} and \u{FFFC} after")
    #expect(result.runs.filter { $0.textual.attachment != nil }.count == 2)
    #expect(result.runs.allSatisfy { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
  }

  @Test func mathRemainsOptIn() throws {
    let result = try AttributedStringMarkdownParser(baseURL: nil).attributedString(for: "$x$")
    #expect(String(result.characters) == "$x$")
  }

  @Test func parsesLongHistoryOnBackgroundExecutor() async throws {
    let source = (0..<256).map { "段落 \($0)： **说明** $x_1 + x_2$。" }.joined(separator: "\n\n")
    let result = try await Task.detached {
      try AttributedStringMarkdownParser.parse(source, syntaxExtensions: [.math])
    }.value
    #expect(result.runs.filter { $0.textual.attachment != nil }.count == 256)
    #expect(String(result.characters).contains("段落 255"))
    #expect(!String(result.characters).contains("AAMATH"))
  }

  @Test func cancelledBackgroundParseDoesNotReturnStaleContent() async {
    let result = await Task.detached {
      withUnsafeCurrentTask { $0?.cancel() }
      return try AttributedStringMarkdownParser.parse("Old reply", syntaxExtensions: [.math])
    }.result
    if case .failure(let error) = result {
      #expect(error is CancellationError)
    } else {
      Issue.record("A cancelled parser returned stale content")
    }
  }

  private func parse(_ source: String) throws -> AttributedString {
    try AttributedStringMarkdownParser(baseURL: nil, syntaxExtensions: [.math]).attributedString(for: source)
  }
}
