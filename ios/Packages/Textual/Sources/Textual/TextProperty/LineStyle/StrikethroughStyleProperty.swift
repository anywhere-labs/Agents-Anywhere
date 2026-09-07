import SwiftUI

/// Applies a strikethrough style attribute.
public struct StrikethroughStyleProperty: TextProperty {
  private let style: Text.LineStyle

  /// Creates a strikethrough style property.
  public init(_ style: Text.LineStyle) {
    self.style = style
  }

  public func apply(
    in attributes: inout AttributeContainer,
    environment _: TextEnvironmentValues
  ) {
    attributes.strikethroughStyle = style
  }
}

extension TextProperty where Self == StrikethroughStyleProperty {
  /// Strikes through text using the given line style.
  public static func strikethroughStyle(_ style: Text.LineStyle) -> Self {
    StrikethroughStyleProperty(style)
  }
}
