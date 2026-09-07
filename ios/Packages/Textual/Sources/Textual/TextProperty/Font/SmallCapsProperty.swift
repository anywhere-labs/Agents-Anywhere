import SwiftUI

/// Applies a small caps font variant.
public struct SmallCapsProperty: TextProperty {
  /// Creates a small caps property.
  public init() {}

  public func apply(in attributes: inout AttributeContainer, environment: TextEnvironmentValues) {
    let font = attributes.font ?? environment.font ?? .body
    attributes.font = font.smallCaps()
  }
}

extension TextProperty where Self == SmallCapsProperty {
  /// Applies a small caps font variant.
  public static var smallCaps: Self { .init() }
}
