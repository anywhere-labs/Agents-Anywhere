import SwiftUI

extension StructuredText {
  /// A style that controls how `StructuredText` renders paragraphs.
  ///
  /// You can set a paragraph style using the ``TextualNamespace/paragraphStyle(_:)`` modifier
  /// or through a bundled ``StructuredText/Style``.
  public protocol ParagraphStyle: DynamicProperty {
    associatedtype Body: View

    /// Creates a view that represents a paragraph.
    @MainActor @ViewBuilder func makeBody(configuration: Self.Configuration) -> Self.Body

    typealias Configuration = BlockStyleConfiguration
  }
}

extension EnvironmentValues {
  @usableFromInline
  @Entry var paragraphStyle: any StructuredText.ParagraphStyle = .default
}
