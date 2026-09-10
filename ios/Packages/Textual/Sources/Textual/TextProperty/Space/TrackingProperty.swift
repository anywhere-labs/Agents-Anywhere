import Foundation

/// Sets a tracking value attribute.
public struct TrackingProperty: TextProperty {
  private let tracking: CGFloat

  /// Creates a tracking property.
  public init(_ tracking: CGFloat) {
    self.tracking = tracking
  }

  public func apply(
    in attributes: inout AttributeContainer,
    environment _: TextEnvironmentValues
  ) {
    attributes.tracking = tracking
  }
}

extension TextProperty where Self == TrackingProperty {
  /// Sets the tracking value.
  public static func tracking(_ tracking: CGFloat) -> Self {
    TrackingProperty(tracking)
  }
}
