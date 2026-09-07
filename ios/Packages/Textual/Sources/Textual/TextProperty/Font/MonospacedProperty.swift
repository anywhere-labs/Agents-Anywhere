import SwiftUI

/// Uses a monospaced font design.
public struct MonospacedProperty: TextProperty {
  /// Creates a monospaced property.
  public init() {}

  public func apply(in attributes: inout AttributeContainer, environment: TextEnvironmentValues) {
    let font = attributes.font ?? environment.font ?? .body
    attributes.font = font.monospaced()
  }
}

extension TextProperty where Self == MonospacedProperty {
  /// Uses a monospaced font design.
  public static var monospaced: Self { .init() }
}
