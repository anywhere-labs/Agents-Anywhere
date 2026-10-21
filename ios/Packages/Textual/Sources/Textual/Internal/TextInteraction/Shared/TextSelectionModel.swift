#if TEXTUAL_ENABLE_TEXT_SELECTION
  import SwiftUI

  // MARK: - Overview
  //
  // `TextSelectionModel` is the shared state object that backs selection and interaction.
  //
  // Platform views (AppKit/UIKit) mutate `selectedRange` in response to gestures and editing
  // commands. The model delegates layout-specific work to a `TextLayoutCollection`, which can be
  // rebuilt at any time as SwiftUI resolves new `Text.Layout` values. When the layout collection
  // changes, the model attempts to reconcile the current selection into the new layout so the
  // selection stays stable across updates.

  @Observable
  final class TextSelectionModel {
    var selectedRange: TextRange? {
      willSet {
        selectionWillChange?()
      }
      didSet {
        if selectedRange != nil {
          coordinator?.modelDidSelectText(self)
        }
        selectionDidChange?()
      }
    }

    @ObservationIgnored
    var selectionWillChange: (() -> Void)?

    @ObservationIgnored
    var selectionDidChange: (() -> Void)?

    @ObservationIgnored
    private var layoutCollection: any TextLayoutCollection

    @ObservationIgnored
    private weak var coordinator: TextSelectionCoordinator?

    /// Whether the interaction currently reads `Text.LayoutKey`.
    ///
    /// Reading it makes SwiftUI re-query the text layout of every fragment whenever the text
    /// moves, for example on each scroll or parent translation frame. On-demand models read it
    /// only while a selection or a tap needs text positions.
    private(set) var readsLayout: Bool

    @ObservationIgnored
    let readsLayoutOnDemand: Bool

    @ObservationIgnored
    private var pendingLayoutAction: ((TextSelectionModel) -> Void)?

    init(
      layoutCollection: any TextLayoutCollection = EmptyTextLayoutCollection(),
      coordinator: TextSelectionCoordinator? = nil,
      readsLayoutOnDemand: Bool = false
    ) {
      self.layoutCollection = layoutCollection
      self.readsLayoutOnDemand = readsLayoutOnDemand
      self.readsLayout = !readsLayoutOnDemand
      setCoordinator(coordinator)
    }

    /// Runs `action` once a layout collection is available, starting to read layouts if needed.
    func withLayout(_ action: @escaping (TextSelectionModel) -> Void) {
      if readsLayout && hasText {
        action(self)
        return
      }
      pendingLayoutAction = action
      if !readsLayout {
        readsLayout = true
      }
    }

    /// Stops reading layouts when nothing needs text positions.
    func releaseLayoutIfIdle() {
      guard readsLayoutOnDemand, readsLayout, selectedRange == nil, pendingLayoutAction == nil
      else { return }
      readsLayout = false
      layoutCollection = EmptyTextLayoutCollection()
    }

    func setLayoutCollection(_ layoutCollection: any TextLayoutCollection) {
      defer { performPendingLayoutAction() }
      guard !layoutCollection.isEqual(to: self.layoutCollection) else {
        return
      }

      let oldLayoutCollection = self.layoutCollection
      self.layoutCollection = layoutCollection

      guard
        let selectedRange
      else {
        return
      }

      if layoutCollection.needsPositionReconciliation(with: oldLayoutCollection) {
        let reconciled = layoutCollection.reconcileRange(selectedRange, from: oldLayoutCollection)
        if reconciled != selectedRange {
          self.selectedRange = reconciled
        }
      } else if !layoutCollection.contains(selectedRange) {
        self.selectedRange = nil
      }
    }

    private func performPendingLayoutAction() {
      guard readsLayout, let action = pendingLayoutAction else { return }
      pendingLayoutAction = nil
      action(self)
    }

    func setCoordinator(_ coordinator: TextSelectionCoordinator?) {
      if self.coordinator === coordinator {
        return
      }

      self.coordinator = coordinator
      coordinator?.register(self)
    }

    func url(for point: CGPoint) -> URL? {
      layoutCollection.url(for: point)
    }

    func layoutIndex(of layout: Text.Layout) -> Int? {
      layoutCollection.index(of: layout)
    }
  }

  extension TextSelectionModel {
    var hasText: Bool {
      layoutCollection.hasText
    }

    func acceptsInteraction(at point: CGPoint, excluding rects: [CGRect]) -> Bool {
      !rects.contains { $0.contains(point) } && hasText
    }

    var startPosition: TextPosition {
      layoutCollection.startPosition
    }

    var endPosition: TextPosition {
      layoutCollection.endPosition
    }

    func attributedText(in range: TextRange) -> NSAttributedString {
      layoutCollection.attributedText(in: range)
    }

    func text(in range: TextRange) -> String {
      attributedText(in: range).string
    }

    func position(from position: TextPosition, offset: Int) -> TextPosition? {
      layoutCollection.position(from: position, offset: offset)
    }

    func offset(from: TextPosition, to: TextPosition) -> Int {
      guard let start = layoutCollection.characterIndex(at: from),
        let end = layoutCollection.characterIndex(at: to)
      else { return 0 }
      return end - start
    }

    func firstRect(for range: TextRange) -> CGRect {
      layoutCollection.firstRect(for: range)
    }

    func caretRect(for position: TextPosition) -> CGRect {
      layoutCollection.caretRect(for: position)
    }

    func selectionRects(for range: TextRange) -> [TextSelectionRect] {
      layoutCollection.selectionRects(for: range)
    }

    func selectionRects(for range: TextRange, layout: Text.Layout) -> [TextSelectionRect] {
      layoutCollection.selectionRects(for: range, layout: layout)
    }

    func closestPosition(to point: CGPoint) -> TextPosition? {
      layoutCollection.closestPosition(to: point)
    }

    func closestPosition(to point: CGPoint, within range: TextRange) -> TextPosition? {
      guard layoutCollection.contains(range) else { return nil }
      guard let position = closestPosition(to: point) else { return nil }
      if position <= range.start { return range.start }
      if position >= range.end { return range.end }
      return position
    }

    func isPositionAtBlockBoundary(_ position: TextPosition) -> Bool {
      layoutCollection.isPositionAtBlockBoundary(position)
    }

    func positionAbove(_ position: TextPosition, anchor: TextPosition) -> TextPosition? {
      layoutCollection.positionAbove(position, anchor: anchor)
    }

    func positionBelow(_ position: TextPosition, anchor: TextPosition) -> TextPosition? {
      layoutCollection.positionBelow(position, anchor: anchor)
    }

    func characterRange(at point: CGPoint) -> TextRange? {
      layoutCollection.characterRange(at: point)
    }

    func blockStart(for position: TextPosition) -> TextPosition? {
      layoutCollection.blockStart(for: position)
    }

    func blockEnd(for position: TextPosition) -> TextPosition? {
      layoutCollection.blockEnd(for: position)
    }

    func blockRange(for position: TextPosition) -> TextRange? {
      layoutCollection.blockRange(for: position)
    }

    @available(macOS 10.0, *)
    @available(iOS, unavailable)
    @available(visionOS, unavailable)
    func wordRange(for position: TextPosition) -> TextRange? {
      layoutCollection.wordRange(for: position)
    }

    @available(macOS 10.0, *)
    @available(iOS, unavailable)
    @available(visionOS, unavailable)
    func nextWord(from position: TextPosition) -> TextPosition? {
      layoutCollection.nextWord(from: position)
    }

    @available(macOS 10.0, *)
    @available(iOS, unavailable)
    @available(visionOS, unavailable)
    func previousWord(from position: TextPosition) -> TextPosition? {
      layoutCollection.previousWord(from: position)
    }
  }
#endif
