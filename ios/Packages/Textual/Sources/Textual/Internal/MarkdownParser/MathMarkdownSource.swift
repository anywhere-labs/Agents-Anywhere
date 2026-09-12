import Foundation

/// Protect TeX before CommonMark consumes its escapes, underscores and line breaks.
/// Restore attachments after parsing so the surrounding Markdown keeps its intents.
struct MathMarkdownSource {
  let source: String
  private let expressions: [String: Expression]
  private let placeholderPattern: NSRegularExpression

  private struct Expression {
    let source: String
    let latex: String
    let block: Bool
  }

  init(_ input: String) {
    // Consume code and link destinations before considering math delimiters.
    // Unclosed fences remain literal while a response is streaming.
    let pattern = #"(?m:^[ ]{0,3}(`{3,}|~{3,})[^\n]*\n(?s:.*?)(?:^[ ]{0,3}\1[ \t]*(?:\n|$)|\z))|(`+)(?s:.*?)\2(?!`)|\]\([^\n]*\)|\\\\|\\\$|(?<block>\$\$(?s:.+?)\$\$)|(?<bracket>\\\[(?s:.+?)\\\])|(?<paren>\\\([^\n]+?\\\))|(?<inline>\$(?!\$|\s)(?:\\.|[^$\n])*?[^\s\\]\$(?!\d)|\$[^\s$\\]\$(?!\d))"#
    let regex = try! NSRegularExpression(pattern: pattern)
    let prefix = "AAMATH" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
    let text = input as NSString
    var output = ""
    var expressions: [String: Expression] = [:]
    var cursor = 0
    for match in regex.matches(in: input, range: NSRange(location: 0, length: text.length)) {
      output += text.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
      let original = text.substring(with: match.range)
      let kind = ["block", "bracket", "paren", "inline"].first {
        match.range(withName: $0).location != NSNotFound
      }
      if let kind {
        let delimiterLength = kind == "inline" ? 1 : 2
        let latex = String(original.dropFirst(delimiterLength).dropLast(delimiterLength))
        let key = prefix + "X" + String(expressions.count) + "Z"
        expressions[key] = Expression(source: original, latex: latex,
          block: kind == "block" || kind == "bracket")
        output += key
      } else {
        output += original
      }
      cursor = NSMaxRange(match.range)
    }
    output += text.substring(from: cursor)
    self.source = output
    self.expressions = expressions
    self.placeholderPattern = try! NSRegularExpression(pattern: prefix + "X[0-9]+Z")
  }

  func restore(_ document: AttributedString) -> AttributedString {
    guard !expressions.isEmpty else { return document }
    var result = AttributedString()
    for run in document.runs {
      let text = String(document[run.range].characters)
      // Keys share a random prefix, so ordinary text and user content cannot collide.
      let matches = placeholderPattern.matches(in: text, range: NSRange(text.startIndex..., in: text))
        .compactMap { match -> (String, Range<String.Index>)? in
          guard let range = Range(match.range, in: text) else { return nil }
          return (String(text[range]), range)
        }
      var cursor = text.startIndex
      for (key, range) in matches {
        result += AttributedString(String(text[cursor..<range.lowerBound]), attributes: run.attributes)
        let expression = expressions[key]!
        let isCode = run.inlinePresentationIntent?.contains(.code) == true
          || run.presentationIntent?.components.contains { if case .codeBlock = $0.kind { true } else { false } } == true
        if isCode {
          result += AttributedString(expression.source, attributes: run.attributes)
        } else {
          result += AttributedString("\u{FFFC}", attributes: run.attributes.attachment(.init(
            MathAttachment(latex: expression.latex, style: expression.block ? .block : .inline))))
        }
        cursor = range.upperBound
      }
      result += AttributedString(String(text[cursor...]), attributes: run.attributes)
    }
    return result
  }
}
