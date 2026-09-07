#if TEXTUAL_ENABLE_TEXT_SELECTION
  import SwiftUI

  // MARK: - Overview
  //
  // `overlayTextLayoutCollection` adapts SwiftUI’s `Text.Layout` preference values into a
  // `TextLayoutCollection` that the selection system can query.
  //
  // The collection includes each anchored layout plus the geometry needed to convert anchors into
  // concrete origins. Platform interactions and selection rendering use the collection for hit
  // testing, position mapping, and selection rectangle computation.

  extension View {
    func overlayTextLayoutCollection(
      size: CGSize,
      @ViewBuilder content: @escaping (any TextLayoutCollection) -> some View
    ) -> some View {
      overlayPreferenceValue(Text.LayoutKey.self) { value in
        GeometryReader { geometry in
          content(LiveTextLayoutCollection(base: value, geometry: geometry))
            .id(size)
        }
      }
    }
  }
#endif
