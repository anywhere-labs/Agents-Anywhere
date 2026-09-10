import SwiftUI

/// A small set of environment values used for resolving dynamic colors.
public struct ColorEnvironmentValues: Hashable, Sendable {
  /// The current color scheme.
  public var colorScheme: ColorScheme

  /// The current color scheme contrast.
  public var colorSchemeContrast: ColorSchemeContrast

  init(
    colorScheme: ColorScheme,
    colorSchemeContrast: ColorSchemeContrast
  ) {
    self.colorScheme = colorScheme
    self.colorSchemeContrast = colorSchemeContrast
  }
}

extension EnvironmentValues {
  var colorEnvironment: ColorEnvironmentValues {
    .init(
      colorScheme: colorScheme,
      colorSchemeContrast: colorSchemeContrast
    )
  }
}
