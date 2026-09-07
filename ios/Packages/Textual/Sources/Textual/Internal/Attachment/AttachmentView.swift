import SwiftUI

// MARK: - Overview
//
// `AttachmentView` draws attachment bodies at the positions reported by SwiftUI's `Text.Layout`.
//
// The `Text` pipeline reserves space for attachments using placeholders; the overlay draws the
// real SwiftUI views on top of those placeholders. Keep those views live: flattening them
// into Canvas symbols prevents embedded image buttons from receiving input.
//
// Selection integration:
// On macOS, when text selection is enabled, object-style attachments are dimmed when they fall
// inside the selected range. Inline-style attachments (for example, emoji) are not dimmed.

struct AttachmentView: View {
  #if TEXTUAL_ENABLE_TEXT_SELECTION && canImport(AppKit)
    @Environment(TextSelectionModel.self) private var textSelectionModel: TextSelectionModel?
  #endif
  private let attachments: Set<AnyAttachment>
  private let origin: CGPoint
  private let layout: Text.Layout

  init(
    attachments: Set<AnyAttachment>,
    origin: CGPoint,
    layout: Text.Layout
  ) {
    self.attachments = attachments
    self.origin = origin
    self.layout = layout
  }

  var body: some View {
    ZStack(alignment: .topLeading) {
      ForEach(Array(layout.indices), id: \.self) { lineIndex in
        let line = layout[lineIndex]
        ForEach(Array(line.indices), id: \.self) { runIndex in
          let run = line[runIndex]
          if let attachment = run.attachment, attachments.contains(attachment) {
            let rect = run.typographicBounds.rect
            attachment.body
              .frame(width: rect.width, height: rect.height)
              .opacity(opacity(for: attachment, lineIndex: lineIndex, runIndex: runIndex))
              .offset(x: origin.x + rect.minX, y: origin.y + rect.minY)
          }
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  private func opacity(
    for attachment: AnyAttachment,
    lineIndex: Int,
    runIndex: Int
  ) -> CGFloat {
    #if TEXTUAL_ENABLE_TEXT_SELECTION && canImport(AppKit)
      guard
        attachment.selectionStyle == .object,
        let textSelectionModel,
        let selectedRange = textSelectionModel.selectedRange,
        let layoutIndex = textSelectionModel.layoutIndex(of: layout)
      else {
        return 1
      }

      let position = TextPosition(
        indexPath: .init(run: runIndex, line: lineIndex, layout: layoutIndex),
        affinity: .downstream
      )

      return selectedRange.contains(position) ? 0.5 : 1
    #else
      1
    #endif
  }
}
