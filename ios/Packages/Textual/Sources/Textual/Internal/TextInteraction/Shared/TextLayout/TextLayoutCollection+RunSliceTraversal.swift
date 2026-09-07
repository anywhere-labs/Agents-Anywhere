#if TEXTUAL_ENABLE_TEXT_SELECTION
  import Foundation

  extension TextLayoutCollection {
    func indexPathsForRunSlices(in range: TextRange) -> some Sequence<IndexPath> {
      guard contains(range) else { return AnySequence<IndexPath>([]) }
      return AnySequence(IndexPathSequence(
        range: range,
        next: self.indexPathForRunSlice(after:),
        previous: self.indexPathForRunSlice(before:)
      ))
    }

    // Empty paragraphs, lines and runs must be skipped in either direction.
    // Selection can span them, but they cannot name a selectable glyph.
    private func indexPathForRunSlice(after path: IndexPath) -> IndexPath? {
      guard contains(path) else { return nil }
      for layoutIndex in path.layout..<layouts.count {
        let layout = layouts[layoutIndex]
        let firstLine = layoutIndex == path.layout ? path.line : 0
        for lineIndex in firstLine..<layout.lines.count {
          let line = layout.lines[lineIndex]
          let sameLine = layoutIndex == path.layout && lineIndex == path.line
          let firstRun = sameLine ? path.run : 0
          for runIndex in firstRun..<line.runs.count {
            let run = line.runs[runIndex]
            let slice = sameLine && runIndex == path.run ? path.runSlice + 1 : 0
            if run.slices.indices.contains(slice) {
              return .init(runSlice: slice, run: runIndex, line: lineIndex, layout: layoutIndex)
            }
          }
        }
      }
      return nil
    }

    private func indexPathForRunSlice(before path: IndexPath) -> IndexPath? {
      guard contains(path) else { return nil }
      for layoutIndex in stride(from: path.layout, through: 0, by: -1) {
        let layout = layouts[layoutIndex]
        let lastLine = layoutIndex == path.layout ? path.line : layout.lines.count - 1
        for lineIndex in stride(from: lastLine, through: 0, by: -1) {
          let line = layout.lines[lineIndex]
          let sameLine = layoutIndex == path.layout && lineIndex == path.line
          let lastRun = sameLine ? path.run : line.runs.count - 1
          for runIndex in stride(from: lastRun, through: 0, by: -1) {
            let run = line.runs[runIndex]
            let slice = sameLine && runIndex == path.run ? path.runSlice - 1 : run.slices.count - 1
            if run.slices.indices.contains(slice) {
              return .init(runSlice: slice, run: runIndex, line: lineIndex, layout: layoutIndex)
            }
          }
        }
      }
      return nil
    }
  }
#endif
