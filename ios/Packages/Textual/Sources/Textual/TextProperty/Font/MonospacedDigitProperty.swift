import SwiftUI

/// Uses monospaced digits.
public struct MonospacedDigitProperty: TextProperty {
  /// Creates a monospaced digit property.
  public init() {}

  public func apply(in attributes: inout AttributeContainer, environment: TextEnvironmentValues) {
    let font = attributes.font ?? environment.font ?? .body
    attributes.font = font.monospacedDigit()
  }
}

extension TextProperty where Self == MonospacedDigitProperty {
  /// Uses monospaced digits.
  public static var monospacedDigit: Self { .init() }
}
