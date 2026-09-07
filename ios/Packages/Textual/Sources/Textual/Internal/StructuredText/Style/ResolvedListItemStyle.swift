import SwiftUI

extension StructuredText {
  // NB: Enables environment resolution in `ListItemStyle`
  struct ResolvedListItemStyle<S: ListItemStyle>: View {
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

extension StructuredText.ListItemStyle {
  @MainActor func resolve(configuration: Configuration) -> some View {
    StructuredText.ResolvedListItemStyle(self, configuration: configuration)
  }
}
