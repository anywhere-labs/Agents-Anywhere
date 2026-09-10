#if TEXTUAL_ENABLE_TEXT_SELECTION
  import SwiftUI

  extension TextLayoutCollection {
    @available(macOS 10.0, *)
    @available(iOS, unavailable)
    @available(visionOS, unavailable)
    func wordRange(for position: TextPosition) -> TextRange? {
      guard contains(position) else {
        return nil
      }
      let layout = layouts[position.indexPath.layout]
      let characterIndex = localCharacterIndex(at: position)

      guard
        let range = layout.wordRange(containing: characterIndex),
        let start = self.position(
          at: position.indexPath.layout,
          localCharacterIndex: range.lowerBound
        ),
        let end = self.position(
          at: position.indexPath.layout,
          localCharacterIndex: range.upperBound
        )
      else { return nil }

      return TextRange(start: start, end: end)
    }

    func blockRange(for position: TextPosition) -> TextRange? {
      guard contains(position) else {
        return nil
      }

      guard let start = firstPosition(in: position.indexPath.layout),
        let end = lastPosition(in: position.indexPath.layout)
      else { return nil }
      return TextRange(start: start, end: end)
    }

    func clampRange(_ range: TextRange, layoutIndex: Int) -> TextRange? {
      guard contains(range), let start = firstPosition(in: layoutIndex),
        let end = lastPosition(in: layoutIndex)
      else { return nil }

      guard range.end > start && range.start < end else {
        return nil
      }

      return TextRange(
        start: Swift.max(range.start, start),
        end: Swift.min(range.end, end)
      )
    }
  }
#endif
