import SwiftUI

/// Applies a font leading setting.
public struct FontLeadingProperty: TextProperty {
  private let leading: Font.Leading

  /// Creates a font leading property.
  public init(_ leading: Font.Leading) {
    self.leading = leading
  }

  public func apply(in attributes: inout AttributeContainer, environment: TextEnvironmentValues) {
    let font = attributes.font ?? environment.font ?? .body
    attributes.font = font.leading(leading)
  }
}

extension TextProperty where Self == FontLeadingProperty {
  /// Applies the given leading setting to the font.
  public static func fontLeading(_ leading: Font.Leading) -> Self {
    FontLeadingProperty(leading)
  }
}
