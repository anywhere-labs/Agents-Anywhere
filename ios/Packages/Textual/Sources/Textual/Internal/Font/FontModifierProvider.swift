import SwiftUI

struct FontModifierProvider<Base: FontProvider, Modifier: FontModifier> {
  var base: Base
  var modifier: Modifier
}

extension FontModifierProvider: FontProvider {
  var scale: CGFloat {
    get { base.scale }
    set { base.scale = newValue }
  }

  func size(in environment: TextEnvironmentValues) -> CGFloat {
    var size = base.size(in: environment)
    modifier.modify(&size)
    return size
  }

  func resolve(in environment: TextEnvironmentValues) -> Font {
    var font = base.resolve(in: environment)
    modifier.modify(&font)
    return font
  }
}
