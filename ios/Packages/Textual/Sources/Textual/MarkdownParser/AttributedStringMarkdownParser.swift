import Foundation

/// A ``MarkupParser`` implementation backed by Foundation’s Markdown support.
///
/// This parser leverages Foundation’s Markdown support and preserves structure via
/// presentation intents.
///
/// This parser can process its output to expand custom emoji and math expressions into
/// inline attachments.
public struct AttributedStringMarkdownParser: MarkupParser {
  private let baseURL: URL?
  private let options: AttributedString.MarkdownParsingOptions
  private let syntaxExtensions: [SyntaxExtension]

  public init(
    baseURL: URL?,
    options: AttributedString.MarkdownParsingOptions = .init(),
    syntaxExtensions: [SyntaxExtension] = []
  ) {
    self.baseURL = baseURL
    self.options = options
    self.syntaxExtensions = syntaxExtensions
  }

  public func attributedString(for input: String) throws -> AttributedString {
    try Self.parse(input, baseURL: baseURL, options: options, syntaxExtensions: syntaxExtensions)
  }

  /// Parse on the caller's executor without constructing a main-actor UI parser.
  nonisolated public static func parse(
    _ input: String,
    baseURL: URL? = nil,
    options: AttributedString.MarkdownParsingOptions = .init(),
    syntaxExtensions: [SyntaxExtension] = []
  ) throws -> AttributedString {
    try Task.checkCancellation()
    let parsesMath = syntaxExtensions.contains { $0.patterns.contains { $0.tokenType == .mathBlock } }
    let processor = PatternProcessor(syntaxExtensions: syntaxExtensions.filter {
      !$0.patterns.contains { $0.tokenType == .mathBlock }
    })
    let protected = parsesMath && MathMarkdownSource.mayContainMath(input) ? MathMarkdownSource(input) : nil
    let document = try processor.expand(
      AttributedString(
        markdown: protected?.source ?? input,
        including: \.textual,
        options: options,
        baseURL: baseURL
      )
    )
    try Task.checkCancellation()
    return protected?.restore(document) ?? document
  }
}

extension MarkupParser where Self == AttributedStringMarkdownParser {
  /// Creates a Markdown parser configured for inline-only syntax.
  public static func inlineMarkdown(
    baseURL: URL? = nil,
    syntaxExtensions: [AttributedStringMarkdownParser.SyntaxExtension] = []
  ) -> Self {
    .init(
      baseURL: baseURL,
      options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace),
      syntaxExtensions: syntaxExtensions
    )
  }

  /// Creates a Markdown parser configured for full-document syntax.
  public static func markdown(
    baseURL: URL? = nil,
    syntaxExtensions: [AttributedStringMarkdownParser.SyntaxExtension] = []
  ) -> Self {
    .init(
      baseURL: baseURL,
      syntaxExtensions: syntaxExtensions
    )
  }
}
