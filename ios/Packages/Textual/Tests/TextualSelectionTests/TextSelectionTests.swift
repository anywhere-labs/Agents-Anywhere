import SwiftUI
import Testing
@testable import Textual

@Suite @MainActor
struct TextSelectionTests {
    @Test func hitTestingDoesNotMaterializeTheDocument() {
        let collection = HitTestCollection()
        let model = TextSelectionModel(layoutCollection: collection)
        for _ in 0..<120 {
            #expect(model.acceptsInteraction(at: .zero, excluding: []))
            #expect(model.hasText)
        }
        #expect(collection.layoutReads == 0)
    }

    @Test func excludedControlsDoNotQueryTextAtAll() {
        let collection = HitTestCollection()
        let model = TextSelectionModel(layoutCollection: collection)
        #expect(!model.acceptsInteraction(at: CGPoint(x: 10, y: 10),
            excluding: [CGRect(x: 0, y: 0, width: 100, height: 100)]))
        #expect(collection.presenceReads == 0)
        #expect(collection.layoutReads == 0)
    }

    @Test func emptySelectionOverlayDoesNotInterceptControls() {
        let model = TextSelectionModel()
        #expect(!model.acceptsInteraction(at: .zero, excluding: []))
        model.setLayoutCollection(SampleCollection([sampleText]))
        #expect(model.acceptsInteraction(at: .zero, excluding: []))
        model.setLayoutCollection(SampleCollection([]))
        #expect(!model.acceptsInteraction(at: .zero, excluding: []))
    }

    @Test func embeddedControlsReceiveTouchesWhileSurroundingTextRemainsSelectable() {
        let model = TextSelectionModel(layoutCollection: SampleCollection([sampleText]))
        let controls = [CGRect(x: 20, y: 0, width: 40, height: 20),
                        CGRect(x: 0, y: 40, width: 100, height: 80)]
        #expect(!model.acceptsInteraction(at: CGPoint(x: 30, y: 10), excluding: controls))
        #expect(!model.acceptsInteraction(at: CGPoint(x: 50, y: 60), excluding: controls))
        #expect(model.acceptsInteraction(at: CGPoint(x: 10, y: 10), excluding: controls))
        #expect(model.acceptsInteraction(at: CGPoint(x: 90, y: 10), excluding: controls))
    }

    @Test func emptyLayoutsDoNotDereferenceThePlaceholderPosition() {
        let emptyStates: [[SampleLayout]] = [
            [], [SampleLayout(lines: [])],
            [SampleLayout(lines: [SampleLine(runs: [])])],
            [SampleLayout(lines: [SampleLine(runs: [SampleRun(slices: [])])])],
        ]
        for layouts in emptyStates {
            let collection = SampleCollection(layouts)
            let position = collection.startPosition
            #expect(position == collection.endPosition)
            #expect(collection.localCharacterRange(at: position.indexPath).isEmpty)
            #expect(collection.characterIndex(at: position) == nil)
            #expect(collection.position(from: position, offset: 0) == nil)
            #expect(collection.position(at: 0, localCharacterIndex: 0) == nil)
            #expect(collection.closestPosition(to: .zero) == nil)
            #expect(collection.characterRange(at: .zero) == nil)
        }
    }

    @Test func staleUIKitPositionsAreSafeAtEveryIndexLevel() {
        let model = TextSelectionModel(layoutCollection: SampleCollection([sampleText]))
        let paths = [
            [], [0], [-1, 0, 0, 0], [1, 0, 0, 0], [0, 1, 0, 0],
            [0, 0, 1, 0], [0, 0, 0, 3], [0, -1, 0, 0], [0, 0, -1, 0], [0, 0, 0, -1],
        ]
        for path in paths {
            let start = TextPosition(indexPath: IndexPath(indexes: path), affinity: .downstream)
            let end = TextPosition(indexPath: start.indexPath, affinity: .upstream)
            let range = TextRange(start: start, end: end)
            #expect(model.position(from: start, offset: 0) == nil)
            #expect(model.offset(from: start, to: end) == 0)
            #expect(model.text(in: range).isEmpty)
            #expect(model.firstRect(for: range) == .zero)
            #expect(model.caretRect(for: start) == .zero)
            #expect(model.selectionRects(for: range).isEmpty)
            #expect(!model.isPositionAtBlockBoundary(start))
            #expect(model.positionAbove(start, anchor: end) == nil)
            #expect(model.positionBelow(start, anchor: end) == nil)
            #expect(model.blockRange(for: start) == nil)
            #expect(model.blockStart(for: start) == nil)
            #expect(model.blockEnd(for: start) == nil)
        }
    }

    @Test func layoutReplacementClearsSelectionButRetainedUIKitQueriesDoNotCrash() {
        for reconcile in [false, true] {
            let model = TextSelectionModel(layoutCollection: SampleCollection([sampleText]))
            let start = model.startPosition
            let end = model.endPosition
            let selected = TextRange(start: start, end: end)
            model.selectedRange = selected
            model.setLayoutCollection(SampleCollection([], reconcile: reconcile))
            #expect(model.selectedRange == nil)
            #expect(model.offset(from: start, to: end) == 0)
            #expect(model.text(in: selected).isEmpty)
            #expect(model.selectionRects(for: selected).isEmpty)
            #expect(!model.isPositionAtBlockBoundary(end))
        }
    }

    @Test func sameCountEmptyLayoutAlsoInvalidatesSelection() {
        let model = TextSelectionModel(layoutCollection: SampleCollection([sampleText]))
        model.selectedRange = TextRange(start: model.startPosition, end: model.endPosition)
        model.setLayoutCollection(SampleCollection([SampleLayout(lines: [])]))
        #expect(model.selectedRange == nil)
    }

    @Test func selectionReconcilesAfterTextReflowsIntoDifferentLines() throws {
        let model = TextSelectionModel(layoutCollection: SampleCollection([sampleText]))
        model.selectedRange = TextRange(start: model.startPosition, end: model.endPosition)
        let wrapped = SampleLayout(text: sampleText.text, lines: [
            SampleLine(runs: [SampleRun(ranges: [0..<1, 1..<3])]),
            SampleLine(runs: [SampleRun(ranges: [3..<4])]),
        ])
        model.setLayoutCollection(SampleCollection([wrapped]))
        let selected = try #require(model.selectedRange)
        #expect(selected.end.indexPath.line == 1)
        #expect(model.text(in: selected) == "A🙂中")
        #expect(model.offset(from: selected.start, to: selected.end) == 4)
    }

    @Test func documentEdgesSkipEmptyParagraphsLinesAndRuns() {
        let content = SampleLayout(text: "A", lines: [
            SampleLine(runs: []),
            SampleLine(runs: [SampleRun(slices: []), SampleRun(ranges: [0..<1]), SampleRun(slices: [])]),
            SampleLine(runs: []),
        ])
        let collection = SampleCollection([SampleLayout(lines: []), content, SampleLayout(lines: [])])
        let expected = IndexPath(runSlice: 0, run: 1, line: 1, layout: 1)
        #expect(collection.startPosition.indexPath == expected)
        #expect(collection.endPosition.indexPath == expected)
        #expect(collection.position(from: collection.startPosition, offset: 0) == collection.startPosition)
        #expect(collection.position(from: collection.endPosition, offset: -1) == collection.startPosition)
        #expect(collection.isPositionAtBlockBoundary(collection.startPosition))
        #expect(collection.isPositionAtBlockBoundary(collection.endPosition))
        let range = TextRange(start: collection.startPosition, end: collection.endPosition)
        #expect(collection.attributedText(in: range).string == "A")
        #expect(Array(collection.indexPathsForRunSlices(in: range)) == [expected])
    }

    @Test func selectionTraversalSkipsEmptyStructuresInBothDirections() {
        let a = SampleLayout(text: "A", lines: [SampleLine(runs: [SampleRun(ranges: [0..<1])])])
        let b = SampleLayout(text: "B", lines: [
            SampleLine(runs: []), SampleLine(runs: [SampleRun(slices: []), SampleRun(ranges: [0..<1])]),
        ])
        let collection = SampleCollection([a, SampleLayout(lines: []), b])
        let first = collection.startPosition
        let last = collection.endPosition
        let full = TextRange(start: first, end: last)
        #expect(Array(collection.indexPathsForRunSlices(in: full)) == [first.indexPath, last.indexPath])
        #expect(collection.attributedText(in: full).string == "AB")
        let excludeFirst = TextRange(start: .init(indexPath: first.indexPath, affinity: .upstream), end: last)
        #expect(Array(collection.indexPathsForRunSlices(in: excludeFirst)) == [last.indexPath])
        let excludeLast = TextRange(start: first, end: .init(indexPath: last.indexPath, affinity: .downstream))
        #expect(Array(collection.indexPathsForRunSlices(in: excludeLast)) == [first.indexPath])
        #expect(!collection.selectionRects(for: full).isEmpty)
    }

    @Test func validTextSelectionPreservesUnicodeAndRangeBoundaries() throws {
        let collection = SampleCollection([sampleText])
        let emojiStart = try #require(collection.position(at: 0, localCharacterIndex: 1))
        let emojiEnd = try #require(collection.position(at: 0, localCharacterIndex: 3))
        #expect(collection.attributedText(in: TextRange(start: emojiStart, end: emojiEnd)).string == "🙂")
        #expect(collection.characterIndex(at: collection.endPosition) == 4)
        #expect(collection.position(from: collection.endPosition, offset: Int.max) == nil)
        #expect(collection.position(from: collection.startPosition, offset: -1) == nil)
    }

    private var sampleText: SampleLayout {
        SampleLayout(text: "A🙂中", lines: [SampleLine(runs: [SampleRun(ranges: [0..<1, 1..<3, 3..<4])])])
    }
}

private final class SampleCollection: TextLayoutCollection {
    let layouts: [any TextLayout]
    let reconcile: Bool
    init(_ layouts: [SampleLayout], reconcile: Bool = true) {
        self.layouts = layouts
        self.reconcile = reconcile
    }
    func isEqual(to other: any TextLayoutCollection) -> Bool { self === (other as? SampleCollection) }
    func needsPositionReconciliation(with other: any TextLayoutCollection) -> Bool { reconcile }
    func index(of layout: Text.Layout) -> Int? { nil }
}

private struct SampleLayout: TextLayout {
    var text = ""
    var lines: [any TextLine]
    var attributedString: NSAttributedString { NSAttributedString(string: text) }
    let origin = CGPoint.zero
    let bounds = CGRect(x: 0, y: 0, width: 100, height: 20)
}

private struct SampleLine: TextLine {
    var runs: [any TextRun]
    let origin = CGPoint.zero
    let typographicBounds = CGRect(x: 0, y: 0, width: 100, height: 20)
}

private struct SampleRun: TextRun {
    var slices: [any TextRunSlice]
    let layoutDirection = LayoutDirection.leftToRight
    let typographicBounds = CGRect(x: 0, y: 0, width: 100, height: 20)
    let url: URL? = nil
    init(slices: [any TextRunSlice]) { self.slices = slices }
    init(ranges: [Range<Int>]) { slices = ranges.map(SampleSlice.init) }
}

private struct SampleSlice: TextRunSlice {
    let characterRange: Range<Int>
    var typographicBounds: CGRect {
        CGRect(x: characterRange.lowerBound * 10, y: 0, width: characterRange.count * 10, height: 20)
    }
}

/// A layout snapshot with a cheap presence query and an expensive contents path.
private final class HitTestCollection: TextLayoutCollection {
    var layoutReads = 0
    var presenceReads = 0
    var hasText: Bool { presenceReads += 1; return true }
    var layouts: [any TextLayout] { layoutReads += 1; return [] }
    func isEqual(to other: any TextLayoutCollection) -> Bool { self === (other as? HitTestCollection) }
    func needsPositionReconciliation(with other: any TextLayoutCollection) -> Bool { false }
    func index(of layout: Text.Layout) -> Int? { nil }
}
