import SwiftUI

extension StructuredText {
  /// The default list item style used by ``StructuredText/DefaultStyle``.
  public struct DefaultListItemStyle: ListItemStyle {
    private let markerSpacing: FontScaled<CGFloat>

    /// Creates a list item style with a custom marker spacing.
    ///
    /// - Parameter markerSpacing: The font-relative horizontal spacing between the marker and the item content.
    public init(markerSpacing: FontScaled<CGFloat>) {
      self.markerSpacing = markerSpacing
    }

    public func makeBody(configuration: Configuration) -> some View {
      WithFontScaledValue(markerSpacing) {
        HStack(alignment: .firstTextCenter, spacing: $0) {
          configuration.marker
          configuration.block
        }
      }
    }
  }
}

extension StructuredText.ListItemStyle where Self == StructuredText.DefaultListItemStyle {
  /// The default list item style.
  public static var `default`: Self {
    .init(markerSpacing: .fontScaled(0.5))
  }

  /// The default list item style with a custom marker spacing.
  ///
  /// - Parameter markerSpacing: The font-relative horizontal spacing between the marker and the item content.
  public static func `default`(markerSpacing: FontScaled<CGFloat>) -> Self {
    .init(markerSpacing: markerSpacing)
  }
}

@available(tvOS, unavailable)
@available(watchOS, unavailable)
#Preview("OrderedList") {
  StructuredText(
    markdown: """
      This is an incomplete list of headgear:

      1. Hats
      1. Caps
      1. Bonnets

      Some more:

      10. Helmets
      1. Hoods
      1. Headbands
         1. Headscarves
         1. Wimples

      A list with a high start:

      999. The sky above the port was the color of television, tuned to a dead channel.
      1. It was a bright cold day in April, and the clocks were striking thirteen.
      """
  )
  .padding()
  .textual.textSelection(.enabled)
}

@available(tvOS, unavailable)
@available(watchOS, unavailable)
#Preview("UnorderedList") {
  StructuredText(
    markdown: """
      * Systems
        * FFF units
        * Great Underground Empire (Zork)
        * Potrzebie
          * Equals the thickness of Mad issue 26
            * Developed by 19-year-old Donald E. Knuth
      """
  )
  .padding()
  .textual.textSelection(.enabled)
  .textual.unorderedListMarker(.hierarchical(.disc, .circle, .square))
}
