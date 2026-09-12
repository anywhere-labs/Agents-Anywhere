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

struct AttachmentView: View, Equatable {
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

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.origin == rhs.origin && lhs.attachments == rhs.attachments && lhs.layout == rhs.layout
  }

  private struct Placement: Identifiable {
    let line: Int
    let run: Int
    let attachment: AnyAttachment
    let rect: CGRect
    var id: IndexPath { IndexPath(indexes: [line, run]) }
  }

  private var placements: [Placement] {
    var result: [Placement] = []
    for lineIndex in layout.indices {
      let line = layout[lineIndex]
      for runIndex in line.indices {
        let run = line[runIndex]
        guard let attachment = run.attachment, attachments.contains(attachment) else { continue }
        result.append(Placement(line: lineIndex, run: runIndex, attachment: attachment,
          rect: run.typographicBounds.rect))
      }
    }
    return result
  }

  var body: some View {
    ZStack(alignment: .topLeading) {
      // Build views only for real attachments, not empty nodes for every text run.
      ForEach(placements) { placement in
        placement.attachment.body
          .frame(width: placement.rect.width, height: placement.rect.height)
          .opacity(opacity(for: placement.attachment, lineIndex: placement.line, runIndex: placement.run))
          .offset(x: origin.x + placement.rect.minX, y: origin.y + placement.rect.minY)
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
