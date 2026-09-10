import SwiftUI

extension StructuredText {
  /// The default heading style used by ``StructuredText/DefaultStyle``.
  public struct DefaultHeadingStyle: HeadingStyle {
    private static let lineSpacings: [CGFloat] = [0.1, 0.25, 0.143, 0.167, 0.182, 0.471]
    private static let fontScales: [CGFloat] = [2.353, 1.882, 1.647, 1.412, 1.294, 1]

    public func makeBody(configuration: Configuration) -> some View {
      let headingLevel = min(configuration.headingLevel, 6)
      let lineSpacing = Self.lineSpacings[headingLevel - 1]
      let fontScale = Self.fontScales[headingLevel - 1]

      configuration.label
        .textual.fontScale(fontScale)
        .textual.lineSpacing(.fontScaled(lineSpacing))
        .textual.blockSpacing(.fontScaled(top: 1.6, bottom: 0.8))
        .fontWeight(.semibold)
    }
  }
}

extension StructuredText.HeadingStyle where Self == StructuredText.DefaultHeadingStyle {
  /// The default heading style.
  public static var `default`: Self {
    .init()
  }
}

@available(tvOS, unavailable)
@available(watchOS, unavailable)
#Preview {
  StructuredText(
    markdown: """
      Paragraph.
      # Heading 1
      Paragraph.
      ## Heading 2
      Paragraph.
      ### Heading 3
      Paragraph.
      #### Heading 4
      Paragraph.
      ##### Heading 5
      Paragraph.
      ###### Heading 6
      Paragraph.
      """
  )
  .padding()
  .textual.textSelection(.enabled)
}
