import SwiftUI

extension StructuredText {
  // NB: Enables environment resolution in `CodeBlockStyle`
  struct ResolvedCodeBlockStyle<S: CodeBlockStyle>: View {
    private let style: S
    private let configuration: S.Configuration

    init(_ style: S, configuration: S.Configuration) {
      self.style = style
      self.configuration = configuration
    }

    var body: S.Body {
      style.makeBody(configuration: configuration)
    }
  }
}

extension StructuredText.CodeBlockStyle {
  @MainActor func resolve(configuration: Configuration) -> some View {
    StructuredText.ResolvedCodeBlockStyle(self, configuration: configuration)
  }
}
