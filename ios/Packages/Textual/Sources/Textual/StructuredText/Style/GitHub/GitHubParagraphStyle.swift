import SwiftUI

extension StructuredText {
  /// A paragraph style inspired by GitHub’s rendering.
  public struct GitHubParagraphStyle: ParagraphStyle {
    /// Creates the GitHub paragraph style.
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
      configuration.label
        .textual.lineSpacing(.fontScaled(0.25))
        .textual.blockSpacing(.init(top: 0, bottom: 16))
    }
  }
}

extension StructuredText.ParagraphStyle where Self == StructuredText.GitHubParagraphStyle {
  /// A GitHub-like paragraph style.
  public static var gitHub: Self {
    .init()
  }
}

#Preview {
  StructuredText(
    markdown: """
      The sky above the port was the color of television,
      tuned to a dead channel.

      It was a bright cold day in April, and the clocks were
      striking thirteen.
      """
  )
  .padding()
  .textual.paragraphStyle(.gitHub)
}
