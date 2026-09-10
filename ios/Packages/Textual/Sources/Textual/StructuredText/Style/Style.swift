import SwiftUI

extension StructuredText {
  /// A collection of styles that control how `StructuredText` renders each block type.
  ///
  /// Use this protocol to bundle a consistent look (paragraphs, headings, lists, code blocks,
  /// tables, and so on) and apply it using the ``TextualNamespace/structuredTextStyle(_:)``
  /// modifier.
  public protocol Style {
    associatedtype HeadingStyle: StructuredText.HeadingStyle
    associatedtype ParagraphStyle: StructuredText.ParagraphStyle
    associatedtype BlockQuoteStyle: StructuredText.BlockQuoteStyle
    associatedtype CodeBlockStyle: StructuredText.CodeBlockStyle
    associatedtype ListItemStyle: StructuredText.ListItemStyle
    associatedtype UnorderedListMarker: StructuredText.UnorderedListMarker
    associatedtype OrderedListMarker: StructuredText.OrderedListMarker
    associatedtype TableStyle: StructuredText.TableStyle
    associatedtype TableCellStyle: StructuredText.TableCellStyle
    associatedtype ThematicBreakStyle: StructuredText.ThematicBreakStyle

    /// The inline style used for spans within a block.
    var inlineStyle: InlineStyle { get }
    /// The style used for headings.
    var headingStyle: HeadingStyle { get }
    /// The style used for paragraphs.
    var paragraphStyle: ParagraphStyle { get }
    /// The style used for block quotes.
    var blockQuoteStyle: BlockQuoteStyle { get }
    /// The style used for code blocks.
    var codeBlockStyle: CodeBlockStyle { get }
    /// The style used for list items.
    var listItemStyle: ListItemStyle { get }
    /// The marker used for unordered lists.
    var unorderedListMarker: UnorderedListMarker { get }
    /// The marker used for ordered lists.
    var orderedListMarker: OrderedListMarker { get }
    /// The style used for tables.
    var tableStyle: TableStyle { get }
    /// The style used for individual table cells.
    var tableCellStyle: TableCellStyle { get }
    /// The style used for thematic breaks.
    var thematicBreakStyle: ThematicBreakStyle { get }
  }
}
