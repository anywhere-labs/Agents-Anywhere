import Foundation

/// A custom emoji definition used during syntax extension expansion after Markdown parsing.
///
/// You can pass a set of `Emoji` values by adding
/// ``AttributedStringMarkdownParser/SyntaxExtension/emoji(_:)`` to
/// `syntaxExtensions` to expand `:shortcode:` sequences into inline attachments.
public struct Emoji: Hashable, Sendable, Codable {
  /// The shortcode used in the markup, without surrounding `:` characters.
  public let shortcode: String

  /// The URL to load the emoji image from.
  public let url: URL

  /// Creates a custom emoji definition.
  public init(shortcode: String, url: URL) {
    self.shortcode = shortcode
    self.url = url
  }
}
