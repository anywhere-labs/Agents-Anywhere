import SwiftUI

// MARK: - Overview
//
// Provides environment-aware font resolution for Font.TextStyle (body, headline, title, etc.).
// These fonts scale with Dynamic Type and respect legibilityWeight on iOS.
//
// When scale != 1, Font.system() cannot be used because SwiftUI doesn't provide an API to
// apply arbitrary scaling while preserving text style metadata. We instead construct the font
// manually with CTFont using the preferred font descriptor and multiplying the point size.
//
// Font.Weight has no public API to extract the CGFloat value needed for font descriptor traits,
// so we use reflection via Mirror.

struct TextStyleFontProvider {
  var style: Font.TextStyle
  var design: Font.Design?
  var weight: Font.Weight?
  var scale: CGFloat = 1
}

extension TextStyleFontProvider: FontProvider {
  func size(in environment: TextEnvironmentValues) -> CGFloat {
    FontDescriptor.preferredFontDescriptor(
      withTextStyle: style,
      in: environment
    ).pointSize * scale
  }

  func resolve(in environment: TextEnvironmentValues) -> Font {
    guard scale != 1 else {
      return Font.system(style, design: design, weight: weight)
    }

    var fontDescriptor: FontDescriptor = .preferredFontDescriptor(
      withTextStyle: style,
      in: environment
    )

    if let design, let withDesign = fontDescriptor.withDesign(.init(design)) {
      fontDescriptor = withDesign
    }

    if let weight = weight?.value {
      fontDescriptor = fontDescriptor.addingAttributes(
        [.traits: [FontDescriptor.TraitKey.weight: weight]]
      )
    }

    return Font(CTFont(fontDescriptor, size: fontDescriptor.pointSize * scale))
  }
}

extension Font.Weight {
  fileprivate var value: CGFloat? {
    Mirror(reflecting: self).descendant("value") as? CGFloat
  }
}

extension FontDescriptor.SystemDesign {
  fileprivate init(_ design: Font.Design) {
    switch design {
    case .default:
      self = .default
    case .serif:
      self = .serif
    case .rounded:
      self = .rounded
    case .monospaced:
      self = .monospaced
    @unknown default:
      self = .default
    }
  }
}
