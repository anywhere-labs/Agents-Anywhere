import SwiftUI

extension StructuredText {
  /// A block quote style inspired by GitHub’s rendering.
  public struct GitHubBlockQuoteStyle: BlockQuoteStyle {
    /// Creates the GitHub block quote style.
    public init() {
    }

    public func makeBody(configuration: Configuration) -> some View {
      HStack(spacing: 0) {
        RoundedRectangle(cornerRadius: 6)
          .fill(DynamicColor.gitHubBorder)
          .textual.frame(width: .fontScaled(0.2))
        configuration.label
          .foregroundStyle(DynamicColor.gitHubSecondary)
          .textual.padding(.horizontal, .fontScaled(1))
      }
    }
  }
}

extension StructuredText.BlockQuoteStyle where Self == StructuredText.GitHubBlockQuoteStyle {
  /// A GitHub-like block quote style.
  public static var gitHub: Self {
    .init()
  }
}

#Preview {
  StructuredText(
    markdown: """
      The sky above the port was the color of television, tuned to a dead channel.

      > Outside of a dog, a book is man's best friend. Inside of a dog it's too dark to read.

      It was a bright cold day in April, and the clocks were striking thirteen.
      """
  )
  .padding()
  .textual.blockQuoteStyle(.gitHub)
  .textual.paragraphStyle(.gitHub)
}
