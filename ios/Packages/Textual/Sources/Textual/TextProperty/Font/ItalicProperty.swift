import SwiftUI

/// Applies an italic font trait.
public struct ItalicProperty: TextProperty {
  /// Creates an italic property.
  public init() {}

  public func apply(in attributes: inout AttributeContainer, environment: TextEnvironmentValues) {
    let font = attributes.font ?? environment.font ?? .body
    attributes.font = font.italic()
  }
}

extension TextProperty where Self == ItalicProperty {
  /// Applies an italic font trait.
  public static var italic: Self { .init() }
}
