import Foundation

/// Converts markup into attributed content that Textual can render.
///
/// `InlineText` and `StructuredText` accept a `MarkupParser` to turn an input `String` into an
/// `AttributedString`. The resulting attributed content can include Foundation attributes, along with
/// Textual-specific attributes used for attachments and custom emoji.
///
/// Textual looks for a small set of well-known attributes when rendering:
///
/// `PresentationIntentAttribute`, `InlinePresentationIntentAttribute`,
/// `LinkAttribute`, and `ImageURLAttribute`.
///
/// It also supports its own attributes for carrying resolved attachments and custom emoji URLs:
///
/// ``Foundation/AttributeScopes/TextualAttributes/AttachmentAttribute`` and
/// ``Foundation/AttributeScopes/TextualAttributes/EmojiURLAttribute``.
///
/// Textual ships with a Markdown parser out of the box: ``AttributedStringMarkdownParser``.
///
/// ```swift
/// InlineText("**Hello** _world_", parser: .inlineMarkdown())
/// ```
///
/// If you implement your own parser, keep the output stable and deterministic. Textual may call
/// the parser whenever the input changes.
///
/// For structured content, make sure your output carries the appropriate presentation intents.
/// Textual groups content into blocks by walking `PresentationIntent` changes across runs, so
/// missing or inconsistent intents will typically show up as incorrect block rendering.
@MainActor
public protocol MarkupParser {
  /// Returns attributed content for the given input string.
  ///
  /// - Parameter input: The markup source string.
  /// - Returns: An attributed string representing the parsed markup.
  func attributedString(for input: String) throws -> AttributedString
}
