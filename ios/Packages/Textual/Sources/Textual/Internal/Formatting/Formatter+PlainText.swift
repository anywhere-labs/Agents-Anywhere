import Foundation

extension Formatter {
  func plainText() -> String {
    blockNodes.renderPlainText()
  }
}

// MARK: - Inline rendering

extension Formatter.InlineNode {
  fileprivate func renderPlainText() -> String {
    switch self {
    case .text(let text):
      return text
    case .code(let code):
      return code
    case .strong(let children):
      return children.renderPlainText()
    case .emphasized(let children):
      return children.renderPlainText()
    case .strikethrough(let children):
      return children.renderPlainText()
    case .link(_, let children):
      return children.renderPlainText()
    case .lineBreak:
      return " "
    case .attachment(let attachment):
      return attachment.description
    }
  }
}

extension Array where Element == Formatter.InlineNode {
  fileprivate func renderPlainText() -> String {
    self.map {
      $0.renderPlainText()
    }.joined()
  }
}

// MARK: - Block rendering

extension Formatter.BlockNode {
  fileprivate func renderPlainText(indentationLevel: Int, tightSpacing: Bool) -> String {
    switch self {
    case .paragraph(let children):
      return children.renderPlainText().indented(indentationLevel)
    case .header(_, let children):
      return children.renderPlainText().indented(indentationLevel)
    case .orderedList(let children):
      return children.renderOrderedPlainText(indentationLevel: indentationLevel + 1)
    case .unorderedList(let children):
      return children.renderUnorderedPlainText(indentationLevel: indentationLevel + 1)
    case .codeBlock(_, let code):
      return code.indented(indentationLevel)
    case .blockQuote(let children):
      return children.renderPlainText(
        indentationLevel: indentationLevel + 1, tightSpacing: tightSpacing)
    case .table(_, let children):
      return children.renderPlainText(indentationLevel: indentationLevel)
    case .thematicBreak:
      return "***"
    }
  }
}

extension Array where Element == Formatter.BlockNode {
  fileprivate func renderPlainText(indentationLevel: Int = 0, tightSpacing: Bool = false)
    -> String
  {
    self.map {
      $0.renderPlainText(indentationLevel: indentationLevel, tightSpacing: tightSpacing)
    }.joined(separator: tightSpacing ? "\n" : "\n\n")
  }
}

// MARK: - Table rendering

extension Formatter.TableRow {
  fileprivate func renderPlainText(indentationLevel: Int = 0) -> String {
    cells.map {
      $0.renderPlainText().csvEscaped()
    }
    .joined(separator: ",")
    .indented(indentationLevel)
  }
}

extension Array where Element == Formatter.TableRow {
  fileprivate func renderPlainText(indentationLevel: Int = 0) -> String {
    self.map {
      $0.renderPlainText(indentationLevel: indentationLevel)
    }.joined(separator: "\n")
  }
}

// MARK: - List rendering

extension Formatter.ListItem {
  fileprivate func renderOrderedPlainText(indentationLevel: Int) -> String {
    blocks
      .renderPlainText(indentationLevel: indentationLevel, tightSpacing: true)
      .prefixed(with: "\(ordinal). ", indentationLevel: indentationLevel)
  }

  fileprivate func renderUnorderedPlainText(indentationLevel: Int) -> String {
    blocks
      .renderPlainText(indentationLevel: indentationLevel, tightSpacing: true)
      .prefixed(with: "• ", indentationLevel: indentationLevel)
  }
}

extension Array where Element == Formatter.ListItem {
  fileprivate func renderOrderedPlainText(indentationLevel: Int) -> String {
    self.map {
      $0.renderOrderedPlainText(indentationLevel: indentationLevel)
    }.joined(separator: "\n")
  }

  fileprivate func renderUnorderedPlainText(indentationLevel: Int) -> String {
    self.map {
      $0.renderUnorderedPlainText(indentationLevel: indentationLevel)
    }.joined(separator: "\n")
  }
}

extension String {
  fileprivate func indented(_ level: Int) -> String {
    guard level > 0 else { return self }

    let indented =
      self
      .split(omittingEmptySubsequences: false, whereSeparator: \.isNewline)
      .map { String(repeating: "  ", count: level) + $0 }
      .joined(separator: "\n")
    return self.hasSuffix("\n") ? indented + "\n" : indented
  }

  fileprivate func prefixed(with prefix: String, indentationLevel: Int) -> String {
    let indent = String(repeating: "  ", count: indentationLevel)

    let firstLineEnd = self.firstIndex(where: \.isNewline) ?? self.endIndex
    var firstLine = self[..<firstLineEnd]
    let rest = self[firstLineEnd...]  // includes the newline if present

    if indentationLevel > 0, firstLine.hasPrefix(indent) {
      firstLine = firstLine.dropFirst(indent.count)
    }

    return indent + prefix + firstLine + rest
  }

  fileprivate func csvEscaped() -> String {
    // Quick edge-space check without scanning the whole string
    var needsQuoting =
      (self.unicodeScalars.first?.value == 0x20) || (self.unicodeScalars.last?.value == 0x20)

    // Scan once over UTF-8 to detect commas, quotes, or newlines
    var needsDoubling = false
    for b in self.utf8 {
      switch b {
      case 0x2C:  // ,
        needsQuoting = true
      case 0x22:  // "
        needsQuoting = true
        needsDoubling = true
      case 0x0A,  // \n
        0x0D:  // \r
        needsQuoting = true
      default:
        break
      }
    }

    if !needsQuoting {
      return self
    }

    // If we need quotes but there are no double quotes inside, just wrap
    if !needsDoubling {
      return "\"\(self)\""
    }

    // Otherwise, build once with doubled quotes.
    var out = String()
    out.reserveCapacity(self.utf8.count + 2)  // rough lower bound
    out.append("\"")
    for ch in self {
      if ch == "\"" {
        out.append("\"\"")
      } else {
        out.append(ch)
      }
    }
    out.append("\"")

    return out
  }
}
