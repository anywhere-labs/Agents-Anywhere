#if TEXTUAL_ENABLE_TEXT_SELECTION
  import SwiftUI

  extension TextLayoutCollection {
    var startPosition: TextPosition {
      for index in layouts.indices {
        if let position = firstPosition(in: index) { return position }
      }
      return TextPosition(indexPath: .init(layout: 0), affinity: .upstream)
    }

    var endPosition: TextPosition {
      for index in layouts.indices.reversed() {
        if let position = lastPosition(in: index) { return position }
      }
      return startPosition
    }

    func position(from position: TextPosition, offset: Int) -> TextPosition? {
      guard let from = characterIndex(at: position) else { return nil }
      let (target, overflow) = from.addingReportingOverflow(offset)

      guard !overflow, (0...stringLength).contains(target) else {
        return nil
      }

      // Map target to layout and local character index

      var localTarget = target
      var layout = 0

      while layout < layouts.count {
        let length = layouts[layout].attributedString.length

        if localTarget <= length {
          if let position = self.position(at: layout, localCharacterIndex: localTarget) {
            return position
          }
          // A blank layout at this boundary has no glyph. Keep looking for the
          // next real position, but never skip unresolved nonempty text.
          if localTarget < length { return nil }
        }

        localTarget -= length
        layout += 1
      }

      return contains(endPosition) ? endPosition : nil
    }

    func characterIndex(at position: TextPosition) -> Int? {
      guard contains(position) else { return nil }
      let base = layouts.prefix(position.indexPath.layout)
        .map(\.attributedString.length)
        .reduce(0, +)
      return base + localCharacterIndex(at: position)
    }

    func localCharacterIndex(at position: TextPosition) -> Int {
      let range = localCharacterRange(at: position.indexPath)
      switch position.affinity {
      case .downstream: return range.lowerBound
      case .upstream: return range.upperBound
      }
    }

    func localCharacterRange(at indexPath: IndexPath) -> Range<Int> {
      guard contains(indexPath) else { return 0..<0 }
      let line = layouts[indexPath.layout].lines[indexPath.line]
      return line.runs[indexPath.run]
        .slices[indexPath.runSlice]
        .characterRange
    }

    func layoutDirection(at indexPath: IndexPath) -> LayoutDirection {
      guard contains(indexPath) else { return .leftToRight }
      let line = layouts[indexPath.layout].lines[indexPath.line]
      return line.runs[indexPath.run].layoutDirection
    }

    func position(at layoutIndex: Int, localCharacterIndex: Int) -> TextPosition? {
      guard let start = firstPosition(in: layoutIndex), let end = lastPosition(in: layoutIndex) else {
        return nil
      }
      guard localCharacterIndex > 0 else {
        return start
      }

      let layout = layouts[layoutIndex]
      let stringLength = layout.attributedString.length

      guard localCharacterIndex <= stringLength else {
        return end
      }

      for (i, line) in zip(layout.lines.indices, layout.lines) {
        for (j, run) in zip(line.runs.indices, line.runs) {
          for (k, slice) in zip(run.slices.indices, run.slices) {
            if slice.characterRange.contains(localCharacterIndex) {
              return TextPosition(
                indexPath: .init(
                  runSlice: k,
                  run: j,
                  line: i,
                  layout: layoutIndex
                ),
                affinity: .downstream
              )
            } else if slice.characterRange.upperBound == localCharacterIndex {
              return TextPosition(
                indexPath: .init(
                  runSlice: k,
                  run: j,
                  line: i,
                  layout: layoutIndex
                ),
                affinity: .upstream
              )
            }
          }
        }
      }

      return nil
    }

    func reconcileRange(_ range: TextRange, from other: any TextLayoutCollection) -> TextRange? {
      guard
        layouts.count == other.layouts.count,
        other.contains(range),
        let start = reconcilePosition(range.start, from: other),
        let end = reconcilePosition(range.end, from: other)
      else {
        return nil
      }

      return TextRange(start: start, end: end)
    }

    @available(macOS 10.0, *)
    @available(iOS, unavailable)
    @available(visionOS, unavailable)
    func nextWord(from position: TextPosition) -> TextPosition? {
      guard contains(position) else {
        return nil
      }
      let layout = layouts[position.indexPath.layout]
      let characterIndex = localCharacterIndex(at: position)
      let nextCharacterIndex = layout.attributedString.nextWord(from: characterIndex)

      if nextCharacterIndex >= layout.attributedString.length {
        // try next layout
        guard position.indexPath.layout + 1 < layouts.endIndex else {
          return endPosition
        }

        return self.position(
          at: position.indexPath.layout + 1,
          localCharacterIndex: 0
        )
      }

      return self.position(
        at: position.indexPath.layout,
        localCharacterIndex: nextCharacterIndex
      )
    }

    @available(macOS 10.0, *)
    @available(iOS, unavailable)
    @available(visionOS, unavailable)
    func previousWord(from position: TextPosition) -> TextPosition? {
      guard contains(position) else {
        return nil
      }
      let layout = layouts[position.indexPath.layout]
      let characterIndex = localCharacterIndex(at: position)
      let previousCharacterIndex = layout.attributedString.previousWord(from: characterIndex)

      if previousCharacterIndex == 0 && characterIndex == 0 {
        // Try previous layout
        guard position.indexPath.layout > 0 else {
          return startPosition
        }

        let previousLayout = layouts[position.indexPath.layout - 1]

        guard
          let position = self.position(
            at: position.indexPath.layout - 1,
            localCharacterIndex: previousLayout.attributedString.length - 1
          )
        else {
          return nil
        }

        return previousWord(from: position)
      }

      return self.position(
        at: position.indexPath.layout,
        localCharacterIndex: previousCharacterIndex
      )
    }

    func blockStart(for position: TextPosition) -> TextPosition? {
      guard contains(position), let start = firstPosition(in: position.indexPath.layout) else { return nil }

      // if we are already at the start, move to the previous block
      if position == start, position.indexPath.layout > 0 {
        return firstPosition(in: position.indexPath.layout - 1)
      }

      return start
    }

    func blockEnd(for position: TextPosition) -> TextPosition? {
      guard contains(position), let end = lastPosition(in: position.indexPath.layout) else { return nil }

      // if we are already at the end, move to the next block
      if position == end, position.indexPath.layout + 1 < layouts.endIndex {
        return lastPosition(in: position.indexPath.layout + 1)
      }

      return end
    }
  }

  extension TextLayoutCollection {
    fileprivate func reconcilePosition(
      _ position: TextPosition,
      from other: any TextLayoutCollection
    ) -> TextPosition? {
      self.position(
        at: position.indexPath.layout,
        localCharacterIndex: other.localCharacterIndex(at: position)
      )
    }
  }
#endif
