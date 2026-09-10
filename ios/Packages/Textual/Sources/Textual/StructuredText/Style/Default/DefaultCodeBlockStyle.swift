import SwiftUI

extension StructuredText {
  /// The default code block style used by ``StructuredText/DefaultStyle``.
  public struct DefaultCodeBlockStyle: CodeBlockStyle {
    /// Creates the default code block style.
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
      Overflow {
        configuration.label
          .textual.lineSpacing(.fontScaled(0.39))
          .textual.fontScale(0.882)
          .fixedSize(horizontal: false, vertical: true)
          .monospaced()
          .padding(.vertical, 8)
          .padding(.leading, 14)
      }
      .background(configuration.highlighterTheme.backgroundColor)
      .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 4, style: .continuous)
          .stroke(DynamicColor.grid, lineWidth: 1)
      )
      .textual.blockSpacing(.fontScaled(top: 0.88, bottom: 0))
    }
  }
}

extension StructuredText.CodeBlockStyle where Self == StructuredText.DefaultCodeBlockStyle {
  /// The default code block style.
  public static var `default`: Self {
    .init()
  }
}

@available(tvOS, unavailable)
@available(watchOS, unavailable)
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
  .textual.textSelection(.enabled)
}
