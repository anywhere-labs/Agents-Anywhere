import SwiftUI

/// A value that scales proportionally to the current font size.
///
/// `FontScaled` lets you express measurements (spacing, padding, sizes) in terms of the current
/// font size rather than fixed points. This is useful when you want custom layout values to track
/// dynamic type and custom fonts.
///
/// Textual provides modifiers that accept font-relative values. You can use those modifiers to
/// build custom styles that scale with the current font.
///
/// ```swift
/// struct CompactParagraphStyle: StructuredText.ParagraphStyle {
///   func makeBody(configuration: StructuredText.BlockStyleConfiguration) -> some View {
///     configuration.label
///       .textual.lineSpacing(.fontScaled(0.2))
///       .textual.blockSpacing(.fontScaled(top: 0.8))
///   }
/// }
///
/// StructuredText(markdown: "Hello, world!")
///   .textual.paragraphStyle(CompactParagraphStyle())
/// ```
public struct FontScaled<Value> where Value: FontScalable {
  /// The unscaled value.
  public let value: Value

  /// Creates a font-scaled value.
  public init(_ value: Value) {
    self.value = value
  }

  /// Returns the value scaled for the given environment.
  public func resolve(in environment: TextEnvironmentValues) -> Value {
    let font = environment.font ?? .body

    guard let fontSize = font.provider()?.size(in: environment) else {
      return value
    }

    return value.scaled(by: fontSize)
  }
}

extension FontScaled: Sendable where Value: Sendable {}

extension FontScaled: Equatable where Value: Equatable {}

extension FontScaled: Hashable where Value: Hashable {}

extension FontScaled: Decodable where Value: Decodable {}

extension FontScaled: Encodable where Value: Encodable {}

// MARK: - BinaryFloatingPoint

extension FontScaled where Value: BinaryFloatingPoint {
  /// Wraps a numeric value as a font-scaled value.
  public static func fontScaled(_ value: Value) -> Self {
    FontScaled(value)
  }
}

/// A type that can scale itself proportionally to a font size.
public protocol FontScalable {
  /// Returns the value scaled by the given font size.
  func scaled(by fontSize: CGFloat) -> Self
}

extension FontScalable where Self: BinaryFloatingPoint {
  /// Scales the value by multiplying it by `fontSize`.
  public func scaled(by fontSize: CGFloat) -> Self {
    self * Self(fontSize)
  }
}

extension CGFloat: FontScalable {}
extension Double: FontScalable {}

// MARK: - EdgeInsets

extension EdgeInsets: FontScalable {
  public func scaled(by fontSize: CGFloat) -> EdgeInsets {
    EdgeInsets(
      top: top * fontSize,
      leading: leading * fontSize,
      bottom: bottom * fontSize,
      trailing: trailing * fontSize
    )
  }
}

extension FontScaled where Value == EdgeInsets {
  /// Creates font-scaled insets.
  public static func fontScaled(
    top: CGFloat,
    leading: CGFloat,
    bottom: CGFloat,
    trailing: CGFloat
  ) -> Self {
    FontScaled(
      EdgeInsets(
        top: top,
        leading: leading,
        bottom: bottom,
        trailing: trailing
      )
    )
  }
}

// MARK: - ProposedViewSize

extension ProposedViewSize: FontScalable {
  public func scaled(by fontSize: CGFloat) -> ProposedViewSize {
    ProposedViewSize(
      width: width.map { $0.scaled(by: fontSize) },
      height: height.map { $0.scaled(by: fontSize) }
    )
  }
}

// MARK: - CGSize

extension CGSize: FontScalable {
  public func scaled(by fontSize: CGFloat) -> CGSize {
    CGSize(
      width: width.scaled(by: fontSize),
      height: height.scaled(by: fontSize)
    )
  }
}

extension FontScaled where Value == CGSize {
  /// Creates a font-scaled size.
  public static func fontScaled(width: CGFloat, height: CGFloat) -> Self {
    FontScaled(CGSize(width: width, height: height))
  }
}
