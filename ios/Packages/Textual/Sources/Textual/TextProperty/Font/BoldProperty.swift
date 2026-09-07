import SwiftUI

/// Applies a bold font trait.
public struct BoldProperty: TextProperty {
  /// Creates a bold property.
  public init() {}

  public func apply(in attributes: inout AttributeContainer, environment: TextEnvironmentValues) {
    let font = attributes.font ?? environment.font ?? .body
    attributes.font = font.bold()
  }
}

extension TextProperty where Self == BoldProperty {
  /// Applies a bold font trait.
  public static var bold: Self { .init() }
}
