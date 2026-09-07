#if TEXTUAL_ENABLE_TEXT_SELECTION
  import Foundation

  // MARK: - Overview
  //
  // `TextPosition` identifies a caret position inside the resolved text layout.
  //
  // Positions are expressed as an `IndexPath` into the layout tree (layout → line → run → slice).
  // `Affinity` disambiguates positions that sit exactly on a boundary, like the end of a line or
  // the edge between two run slices. That extra bit of information makes range comparisons and
  // containment behave consistently when the same visual location can map to two adjacent indices.

  struct TextPosition: Hashable, Comparable, CustomStringConvertible {
    enum Affinity: Comparable {
      case downstream  // leading edge in the current layout direction
      case upstream  // trailing edge
    }

    let indexPath: IndexPath
    let affinity: Affinity

    var description: String {
      let path = "(\(indexPath.map(\.description).joined(separator: ", ")))"
      switch affinity {
      case .downstream:
        return "^\(path)"
      case .upstream:
        return "\(path)^"
      }
    }

    static func < (lhs: TextPosition, rhs: TextPosition) -> Bool {
      if lhs.indexPath == rhs.indexPath {
        return lhs.affinity < rhs.affinity
      }
      return lhs.indexPath < rhs.indexPath
    }
  }
#endif
