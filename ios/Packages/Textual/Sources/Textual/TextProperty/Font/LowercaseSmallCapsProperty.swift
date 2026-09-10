import SwiftUI

/// Applies a lowercase small caps font variant.
public struct LowercaseSmallCapsProperty: TextProperty {
  /// Creates a lowercase small caps property.
  public init() {}

  public func apply(in attributes: inout AttributeContainer, environment: TextEnvironmentValues) {
    let font = attributes.font ?? environment.font ?? .body
    attributes.font = font.lowercaseSmallCaps()
  }
}

extension TextProperty where Self == LowercaseSmallCapsProperty {
  /// Applies a lowercase small caps font variant.
  public static var lowercaseSmallCaps: Self { .init() }
}
