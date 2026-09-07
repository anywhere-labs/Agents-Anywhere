import SwiftUI

extension StructuredText {
  struct ThematicBreak: View {
    @Environment(\.thematicBreakStyle) private var thematicBreakStyle

    private let content: AttributedSubstring

    init(_ content: AttributedSubstring) {
      self.content = content
    }

    var body: some View {
      let configuration = BlockStyleConfiguration(
        label: .init(label),
        indentationLevel: indentationLevel
      )
      let resolvedStyle = thematicBreakStyle.resolve(configuration: configuration)

      AnyView(resolvedStyle)
    }

    private var label: some View {
      WithInlineStyle(AttributedString(content)) {
        TextFragment($0)
      }
    }

    private var indentationLevel: Int {
      content.presentationIntent?.indentationLevel ?? 0
    }
  }
}
