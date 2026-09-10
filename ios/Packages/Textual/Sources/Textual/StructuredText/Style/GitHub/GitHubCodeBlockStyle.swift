import SwiftUI

extension StructuredText {
  /// A code block style inspired by GitHub’s rendering.
  public struct GitHubCodeBlockStyle: CodeBlockStyle {
    /// Creates the GitHub code block style.
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
      Overflow {
        configuration.label
          .textual.lineSpacing(.fontScaled(0.225))
          .textual.fontScale(0.85)
          .fixedSize(horizontal: false, vertical: true)
          .monospaced()
          .padding(16)
      }
      .background(DynamicColor.gitHubSecondaryBackground)
      .clipShape(RoundedRectangle(cornerRadius: 6))
      .textual.blockSpacing(.init(top: 0, bottom: 16))
    }
  }
}

extension StructuredText.CodeBlockStyle where Self == StructuredText.GitHubCodeBlockStyle {
  /// A GitHub-like code block style.
  public static var gitHub: Self {
    .init()
  }
}

#Preview {
  StructuredText(
    markdown: """
      The sky above the port was the color of television, tuned to a dead channel.

      ```swift
      struct Sightseeing: Activity {
          func perform(with sloth: inout Sloth) -> Speed {
              sloth.energyLevel -= 10
              return .slow
          }
      }
      ```

      It was a bright cold day in April, and the clocks were striking thirteen.
      """
  )
  .padding()
  .textual.codeBlockStyle(.gitHub)
  .textual.paragraphStyle(.gitHub)
}
