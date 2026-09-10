#if TEXTUAL_ENABLE_TEXT_SELECTION
  import Foundation

  // MARK: - Overview
  //
  // `TextRange` represents a half-open selection range in terms of `TextPosition` values.
  //
  // The range uses `TextPosition.Affinity` to decide whether boundary positions are included.
  // That’s what allows ranges like “caret at the end of a slice” to either include or exclude the
  // slice, depending on whether the caret is considered to be on the leading or trailing edge.

  struct TextRange: Hashable, CustomStringConvertible {
    let start: TextPosition
    let end: TextPosition

    var description: String {
      "[\(start)...\(end)]"
    }

    var isCollapsed: Bool {
      start == end
    }

    init(from: TextPosition, to: TextPosition) {
      if from <= to {
        self.init(start: from, end: to)
      } else {
        self.init(start: to, end: from)
      }
    }

    init(start: TextPosition, end: TextPosition) {
      assert(start <= end)

      self.start = start
      self.end = end
    }

    func contains(_ position: TextPosition) -> Bool {
      (start.affinity == .upstream
        ? position > start
        : position >= start)
        && (end.affinity == .downstream
          ? position < end
          : position <= end)
    }
  }
#endif
