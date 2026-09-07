#if TEXTUAL_ENABLE_TEXT_SELECTION
  import Foundation

  // MARK: - Overview
  //
  // Selection geometry is indexed using a four-component `IndexPath`:
  //
  // `layout` → `line` → `run` → `runSlice`
  //
  // This mirrors SwiftUI’s resolved `Text.Layout` structure while staying independent of AppKit
  // and UIKit. `IndexPathSequence` builds an inclusive/exclusive traversal over run slices based
  // on the start/end affinities of a `TextRange`.

  extension IndexPath {
    var layout: Int {
      self[0]
    }

    var line: Int {
      self[1]
    }

    var run: Int {
      self[2]
    }

    var runSlice: Int {
      self[3]
    }

    init(runSlice: Int, run: Int, line: Int, layout: Int) {
      self.init(indexes: [layout, line, run, runSlice])
    }

    init(run: Int, line: Int, layout: Int) {
      self.init(runSlice: 0, run: run, line: line, layout: layout)
    }

    init(line: Int, layout: Int) {
      self.init(runSlice: 0, run: 0, line: line, layout: layout)
    }

    init(layout: Int) {
      self.init(runSlice: 0, run: 0, line: 0, layout: layout)
    }
  }

  struct IndexPathSequence: Sequence, IteratorProtocol {
    private var current: IndexPath?
    private let end: IndexPath?
    private let _next: (IndexPath) -> IndexPath?

    init(
      range: TextRange,
      next: @escaping (IndexPath) -> IndexPath?,
      previous: @escaping (IndexPath) -> IndexPath?
    ) {
      self.current =
        if range.start.affinity == .upstream {
          // If start is at upstream (trailing edge), skip the start slice
          next(range.start.indexPath)
        } else {
          range.start.indexPath
        }
      self.end =
        if range.end.affinity == .downstream {
          // If end is at downstream (leading edge), do not include the end slice
          previous(range.end.indexPath)
        } else {
          range.end.indexPath
        }
      self._next = next
    }

    mutating func next() -> IndexPath? {
      guard let current, let end else { return nil }
      let value = current
      if value == end {
        self.current = nil
      } else {
        self.current = _next(current)
      }
      return value
    }
  }
#endif
