import SwiftUI

extension StructuredText {
  /// A style that controls how `StructuredText` renders block quotes.
  ///
  /// Apply a block quote style with ``TextualNamespace/blockQuoteStyle(_:)`` or through a bundled
  /// ``StructuredText/Style``.
  public protocol BlockQuoteStyle: DynamicProperty {
    associatedtype Body: View

    /// Creates a view that represents a block quote.
    @MainActor @ViewBuilder func makeBody(configuration: Self.Configuration) -> Self.Body

    typealias Configuration = BlockStyleConfiguration
  }
}

extension EnvironmentValues {
  @usableFromInline
  @Entry var blockQuoteStyle: any StructuredText.BlockQuoteStyle = .default
}
