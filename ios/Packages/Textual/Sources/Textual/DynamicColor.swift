import SwiftUI

/// A color that adapts to the current appearance.
///
/// `DynamicColor` can provide different variants for light and dark mode, and optionally for
/// increased contrast.
///
/// You can use it directly as a `ShapeStyle`, or pass it to Textual APIs that accept dynamic
/// colors (for example, ``TextProperty/foregroundColor(_:)`` and
/// ``TextProperty/backgroundColor(_:)``).
///
/// ```swift
/// let linkColor = DynamicColor(
///   light: .blue,
///   dark: .cyan,
///   highContrastLight: .blue,
///   highContrastDark: .white
/// )
/// ```
public struct DynamicColor: Hashable, Sendable {
  private struct Variant: Hashable, Sendable {
    private let colorScheme: ColorScheme?
    private let colorSchemeContrast: ColorSchemeContrast?

    let color: Color

    var priority: Int {
      (colorScheme != nil ? 1 : 0) + (colorSchemeContrast != nil ? 1 : 0)
    }

    init(
      colorScheme: ColorScheme? = nil,
      colorSchemeContrast: ColorSchemeContrast? = nil,
      color: Color
    ) {
      self.colorScheme = colorScheme
      self.colorSchemeContrast = colorSchemeContrast
      self.color = color
    }

    func matches(_ colorEnvironment: ColorEnvironmentValues) -> Bool {
      (self.colorScheme == nil
        || self.colorScheme == colorEnvironment.colorScheme)
        && (self.colorSchemeContrast == nil
          || self.colorSchemeContrast == colorEnvironment.colorSchemeContrast)
    }
  }

  private let variants: [Variant]

  private init(variants: [Variant]) {
    self.variants = variants
  }

  func bestMatch(for colorEnvironment: ColorEnvironmentValues) -> Color? {
    variants
      .filter { $0.matches(colorEnvironment) }
      .max(by: { $0.priority < $1.priority })?
      .color
  }
}

extension DynamicColor {
  /// Creates a dynamic color with a single variant.
  public init(_ any: Color) {
    self.init(variants: [.init(color: any)])
  }

  /// Creates a dynamic color with light and dark variants.
  ///
  /// - Parameters:
  ///   - light: The color to use in light mode.
  ///   - dark: The color to use in dark mode.
  ///   - highContrastLight: An optional override to use in light mode when contrast is increased.
  ///   - highContrastDark: An optional override to use in dark mode when contrast is increased.
  public init(
    light: Color,
    dark: Color,
    highContrastLight: Color? = nil,
    highContrastDark: Color? = nil
  ) {
    self.init(
      variants: [
        .init(colorScheme: .light, color: light),
        .init(colorScheme: .dark, color: dark),
        highContrastLight.map { color in
          .init(
            colorScheme: .light,
            colorSchemeContrast: .increased,
            color: color
          )
        },
        highContrastDark.map { color in
          .init(
            colorScheme: .dark,
            colorSchemeContrast: .increased,
            color: color
          )
        },
      ].compactMap(\.self)
    )
  }
}

extension DynamicColor: ShapeStyle {
  public func resolve(in environment: EnvironmentValues) -> some ShapeStyle {
    bestMatch(
      for: .init(
        colorScheme: environment.colorScheme,
        colorSchemeContrast: environment.colorSchemeContrast
      )
    ) ?? .clear
  }
}
