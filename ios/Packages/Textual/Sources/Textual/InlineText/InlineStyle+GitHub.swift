import SwiftUI

extension InlineStyle {
  /// The GitHub inline style.
  ///
  /// This style is intended to resemble GitHub’s inline text styling, with compact monospaced
  /// and a subtle background for inline code.
  ///
  /// ```swift
  /// InlineText(markdown: "Use `git status` to check **uncommitted** changes")
  ///   .textual.inlineStyle(.gitHub)
  /// ```
  public static var gitHub: InlineStyle {
    InlineStyle()
      .code(.monospaced, .fontScale(0.85), .backgroundColor(.gitHubSecondaryBackground))
      .strong(.fontWeight(.semibold))
      .link(.foregroundColor(.gitHubLink))
  }
}
