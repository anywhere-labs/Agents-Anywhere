import SwiftUI

extension StructuredText {
  /// Additional spacing to apply above and below a block element.
  ///
  /// A `nil` value means “don’t override” so that spacing can be resolved by the surrounding
  /// styles.
  public struct BlockSpacing: Sendable, Hashable {
    /// The spacing to apply above the block, or `nil` to leave it unchanged.
    public var top: CGFloat?
    /// The spacing to apply below the block, or `nil` to leave it unchanged.
    public var bottom: CGFloat?

    /// Creates a block spacing value.
    public init(top: CGFloat? = nil, bottom: CGFloat? = nil) {
      self.top = top
      self.bottom = bottom
    }

    /// Returns a spacing that prefers the larger of each edge, ignoring `nil` values.
    @inlinable
    public func union(_ other: BlockSpacing) -> BlockSpacing {
      .init(
        top: [top, other.top].compactMap(\.self).max(),
        bottom: [bottom, other.bottom].compactMap(\.self).max()
      )
    }
  }
}

extension StructuredText.BlockSpacing: FontScalable {
  public func scaled(by fontSize: CGFloat) -> StructuredText.BlockSpacing {
    .init(
      top: top.map { $0 * fontSize },
      bottom: bottom.map { $0 * fontSize }
    )
  }
}

extension FontScaled where Value == StructuredText.BlockSpacing {
  /// A convenience constructor for font-scaled `StructuredText.BlockSpacing` values.
  public static func fontScaled(top: CGFloat? = nil, bottom: CGFloat? = nil) -> Self {
    FontScaled(StructuredText.BlockSpacing(top: top, bottom: bottom))
  }
}
