import Foundation

extension StructuredText.HighlighterTheme {
  /// An identifier for a syntax token.
  ///
  /// Token types are backed by a string so you can match the names produced by the highlighter.
  /// You can create them from a raw value or using a string literal.
  public struct TokenType: Hashable, RawRepresentable, Sendable, ExpressibleByStringLiteral {
    /// The underlying token type string.
    public let rawValue: String

    /// Creates a token type from a raw string value.
    public init(rawValue: String) {
      self.rawValue = rawValue
    }

    /// Creates a token type from a string literal.
    public init(stringLiteral value: StringLiteralType) {
      self.rawValue = value
    }
  }
}

extension StructuredText.HighlighterTheme.TokenType {
  // General purpose
  public static let plain: Self = "plain"
  public static let keyword: Self = "keyword"
  public static let builtin: Self = "builtin"
  public static let className: Self = "class-name"
  public static let function: Self = "function"
  public static let boolean: Self = "boolean"
  public static let number: Self = "number"
  public static let string: Self = "string"
  public static let char: Self = "char"
  public static let symbol: Self = "symbol"
  public static let regex: Self = "regex"
  public static let url: Self = "url"
  public static let `operator`: Self = "operator"
  public static let variable: Self = "variable"
  public static let constant: Self = "constant"
  public static let property: Self = "property"
  public static let punctuation: Self = "punctuation"
  public static let important: Self = "important"
  public static let comment: Self = "comment"

  // Markup
  public static let tag: Self = "tag"
  public static let attributeName: Self = "attr-name"
  public static let attributeValue: Self = "attr-value"
  public static let namespace: Self = "namespace"
  public static let prolog: Self = "prolog"
  public static let doctype: Self = "doctype"
  public static let cdata: Self = "cdata"
  public static let entity: Self = "entity"

  // Formatting
  public static let bold: Self = "bold"
  public static let italic: Self = "italic"

  // CSS
  public static let atrule: Self = "atrule"
  public static let selector: Self = "selector"

  // Diff
  public static let inserted: Self = "inserted"
  public static let deleted: Self = "deleted"

  // Comments (specialized)
  public static let blockComment: Self = "block-comment"
  public static let docComment: Self = "doc-comment"
  public static let mark: Self = "mark"

  // Functions (specialized)
  public static let functionName: Self = "function-name"

  // Preprocessor
  public static let preprocessor: Self = "preprocessor"

  // Swift
  public static let directive: Self = "directive"
  public static let literal: Self = "literal"
  public static let otherDirective: Self = "other-directive"
  public static let attribute: Self = "attribute"
  public static let functionDefinition: Self = "function-definition"
  public static let label: Self = "label"
  public static let `nil`: Self = "nil"
  public static let shortArgument: Self = "short-argument"
  public static let omit: Self = "omit"
  public static let interpolation: Self = "interpolation"
  public static let interpolationPunctuation: Self = "interpolation-punctuation"
}
