import SwiftUI

// MARK: - Overview
//
// `AttachmentOverlay` renders attachment views using resolved `Text.Layout` geometry.
//
// It’s applied at the text fragment level. The fragment exposes the resolved layout through the
// `Text.LayoutKey` preference; this modifier reads the anchored layout, converts its anchor to a
// concrete origin using `GeometryReader`, and installs an `AttachmentView` that draws attachments
// at their run bounds.

struct AttachmentOverlay: ViewModifier {
  private let attachments: Set<AnyAttachment>

  init(attachments: Set<AnyAttachment>) {
    self.attachments = attachments
  }

  func body(content: Content) -> some View {
    if attachments.isEmpty {
      // Plain text has no attachment bodies; do not walk every line and run
      // in AttachmentView whenever geometry or the containing card changes.
      content
    } else {
      content
        .overlayPreferenceValue(Text.LayoutKey.self) { value in
          if let anchoredLayout = value.first {
            GeometryReader { geometry in
              AttachmentView(
                attachments: attachments,
                origin: geometry[anchoredLayout.origin],
                layout: anchoredLayout.layout
              )
              .equatable()
            }
          }
        }
    }
  }
}
