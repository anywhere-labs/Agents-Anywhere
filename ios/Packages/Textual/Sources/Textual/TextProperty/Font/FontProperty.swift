import SwiftUI

/// Replaces the font attribute.
///
/// Pass `nil` to clear any explicit font and let the surrounding style decide.
public struct FontProperty: TextProperty {
  private let font: Font?

  /// Creates a font property.
  public init(_ font: Font?) {
    self.font = font
  }

  public func apply(
    in attributes: inout AttributeContainer,
    environment _: TextEnvironmentValues
  ) {
    attributes.font = font
  }
}

extension TextProperty where Self == FontProperty {
  /// Sets the font attribute.
  public static func font(_ font: Font?) -> Self {
    FontProperty(font)
  }
}
