@preconcurrency import CoreText
import SwiftUI

struct PlatformFontProvider {
  var font: CTFont
  var scale: CGFloat = 1
}

extension PlatformFontProvider: FontProvider {
  func size(in _: TextEnvironmentValues) -> CGFloat {
    CTFontGetSize(font) * scale
  }

  func resolve(in _: TextEnvironmentValues) -> Font {
    guard scale != 1 else { return Font(font) }
    return Font(CTFont(CTFontCopyFontDescriptor(font), size: CTFontGetSize(font) * scale))
  }
}
