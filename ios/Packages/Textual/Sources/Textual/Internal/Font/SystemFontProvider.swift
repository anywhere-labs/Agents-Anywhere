import SwiftUI

struct SystemFontProvider {
  var size: CGFloat
  var weight: Font.Weight?
  var design: Font.Design?
  var scale: CGFloat = 1
}

extension SystemFontProvider: FontProvider {
  func size(in _: TextEnvironmentValues) -> CGFloat {
    size * scale
  }

  func resolve(in _: TextEnvironmentValues) -> Font {
    Font.system(size: size * scale, weight: weight, design: design)
  }
}
