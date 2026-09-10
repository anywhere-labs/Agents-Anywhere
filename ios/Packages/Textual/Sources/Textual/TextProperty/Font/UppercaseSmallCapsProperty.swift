import SwiftUI

/// Applies an uppercase small caps font variant.
public struct UppercaseSmallCapsProperty: TextProperty {
  /// Creates an uppercase small caps property.
  public init() {}

  public func apply(in attributes: inout AttributeContainer, environment: TextEnvironmentValues) {
    let font = attributes.font ?? environment.font ?? .body
    attributes.font = font.uppercaseSmallCaps()
  }
}

extension TextProperty where Self == UppercaseSmallCapsProperty {
  /// Applies an uppercase small caps font variant.
  public static var uppercaseSmallCaps: Self { .init() }
}
