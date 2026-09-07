#if TEXTUAL_ENABLE_TEXT_SELECTION
  import Foundation

  extension TextLayoutCollection {
    // UIKit can keep a position after SwiftUI replaces or temporarily empties
    // its layout. Validate the whole path before dereferencing any component.
    func contains(_ position: TextPosition) -> Bool {
      contains(position.indexPath)
    }

    func contains(_ indexPath: IndexPath) -> Bool {
      guard indexPath.count == 4, layouts.indices.contains(indexPath.layout) else { return false }
      let layout = layouts[indexPath.layout]
      guard layout.lines.indices.contains(indexPath.line) else { return false }
      let line = layout.lines[indexPath.line]
      guard line.runs.indices.contains(indexPath.run) else { return false }
      return line.runs[indexPath.run].slices.indices.contains(indexPath.runSlice)
    }

    func contains(_ range: TextRange) -> Bool {
      contains(range.start) && contains(range.end)
    }

    func firstPosition(in layoutIndex: Int) -> TextPosition? {
      guard layouts.indices.contains(layoutIndex) else { return nil }
      for (lineIndex, line) in layouts[layoutIndex].lines.enumerated() {
        for (runIndex, run) in line.runs.enumerated() where !run.slices.isEmpty {
          return TextPosition(
            indexPath: .init(runSlice: 0, run: runIndex, line: lineIndex, layout: layoutIndex),
            affinity: .downstream)
        }
      }
      return nil
    }

    func lastPosition(in layoutIndex: Int) -> TextPosition? {
      guard layouts.indices.contains(layoutIndex) else { return nil }
      for (lineIndex, line) in layouts[layoutIndex].lines.enumerated().reversed() {
        for (runIndex, run) in line.runs.enumerated().reversed() where !run.slices.isEmpty {
          return TextPosition(
            indexPath: .init(runSlice: run.slices.count - 1, run: runIndex, line: lineIndex, layout: layoutIndex),
            affinity: .upstream)
        }
      }
      return nil
    }
  }
#endif
