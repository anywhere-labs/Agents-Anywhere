import Foundation

/// Protect TeX before CommonMark consumes its escapes, underscores and line breaks.
/// Restore attachments after parsing so the surrounding Markdown keeps its intents.
struct MathMarkdownSource {
  let source: String
  private let expressions: [String: Expression]
  private let prefix: String

  /// A byte scan avoids regex/token allocation for ordinary prose and code.
  static func mayContainMath(_ input: String) -> Bool {
    var previous: UInt8 = 0
    for byte in input.utf8 {
      if byte == 36 || previous == 92 && (byte == 40 || byte == 91) { return true }
      previous = byte
    }
    return false
  }

  private static let placeholderPattern = try! NSRegularExpression(pattern: "AAMATH[A-F0-9]{32}X[0-9]+Z")

  private struct Expression {
    let source: String
    let latex: String
    let block: Bool
  }

  private static let expressionPattern: NSRegularExpression = {
    // Consume code and link destinations before considering math delimiters.
    // Unclosed fences remain literal while a response is streaming.
    let pattern = #"(?m:^[ ]{0,3}(`{3,}|~{3,})[^\n]*\n(?s:.*?)(?:^[ ]{0,3}\1[ \t]*(?:\n|$)|\z))|(`+)(?s:.*?)\2(?!`)|\]\([^\n]*\)|\\\\|\\\$|(?<block>\$\$(?s:.+?)\$\$)|(?<bracket>\\\[(?s:.+?)\\\])|(?<paren>\\\([^\n]+?\\\))|(?<inline>\$(?!\$|\s)(?:\\.|[^$\n])*?[^\s\\]\$(?!\d)|\$[^\s$\\]\$(?!\d))"#
    return try! NSRegularExpression(pattern: pattern)
  }()

  init(_ input: String) {
    let prefix = "AAMATH" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
    let text = input as NSString
    var output = ""
    var expressions: [String: Expression] = [:]
    var cursor = 0
    for match in Self.expressionPattern.matches(in: input, range: NSRange(location: 0, length: text.length)) {
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
    self.prefix = prefix
  }

  func restore(_ document: AttributedString) -> AttributedString {
    guard !expressions.isEmpty else { return document }
    var result = AttributedString()
    for run in document.runs {
      let text = String(document[run.range].characters)
      // Most runs contain no formula. Preserve them without regex or rebuilding.
      guard text.contains(prefix) else {
        result.append(document[run.range])
        continue
      }
      // Match the shared token shape, but restore only this parse's random keys.
      let matches = Self.placeholderPattern.matches(in: text, range: NSRange(text.startIndex..., in: text))
        .compactMap { match -> (String, Range<String.Index>)? in
          guard let range = Range(match.range, in: text) else { return nil }
          let key = String(text[range])
          guard expressions[key] != nil else { return nil }
          return (key, range)
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
