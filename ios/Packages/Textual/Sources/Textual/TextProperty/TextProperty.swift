import Foundation

/// A small, composable unit of inline styling.
///
/// A `TextProperty` mutates an `AttributeContainer` for a portion of styled text. Textual applies
/// properties to the text spans it styles, and uses them to build higher-level styles like ``InlineStyle``.
public protocol TextProperty: Sendable, Hashable {
  /// Applies this property to an attribute container.
  ///
  /// Implementations should be deterministic and side-effect free.
  ///
  /// - Parameters:
  ///   - attributes: The attribute container to modify.
  ///   - environment: The resolved text environment for the current view.
  func apply(in attributes: inout AttributeContainer, environment: TextEnvironmentValues)
}

/// A type-erased ``TextProperty``.
///
/// Use `AnyTextProperty` when you need to store or pass text properties without exposing their
/// concrete types, or when you want to combine multiple properties into a single value.
///
/// ```swift
/// let emphasis = AnyTextProperty(
///   .foregroundColor(.purple),
///   .fontWeight(.semibold)
/// )
/// ```
public struct AnyTextProperty: TextProperty {
  let base: any TextProperty

  /// Creates a type-erased wrapper around a concrete property.
  public init(_ base: some TextProperty) {
    if let base = base as? AnyTextProperty {
      self = base
    } else {
      self.base = base
    }
  }

  /// Creates a single property by composing multiple properties.
  public init<each P: TextProperty>(_ properties: repeat each P) {
    self.init(TupleTextProperty(repeat each properties))
  }

  public func apply(in attributes: inout AttributeContainer, environment: TextEnvironmentValues) {
    base.apply(in: &attributes, environment: environment)
  }

  public static func == (lhs: Self, rhs: Self) -> Bool {
    AnyHashable(lhs.base) == AnyHashable(rhs.base)
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(base)
  }
}
