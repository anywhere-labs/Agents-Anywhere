import Foundation

/// Relative geometry for detecting layout changes and retaining history. It
/// deliberately does not infer arrival or a target offset from native insets.
nonisolated struct TimelineViewport: Equatable {
    let contentHeight: CGFloat
    let visibleHeight: CGFloat
    let visibleBottom: CGFloat
    let offsetY: CGFloat
    let topInset: CGFloat

    init(contentHeight: CGFloat = 0, containerHeight: CGFloat = 0,
         topInset: CGFloat = 0, bottomInset: CGFloat = 0, offsetY: CGFloat = 0) {
        self.contentHeight = max(0, contentHeight)
        visibleHeight = max(0, containerHeight - topInset - bottomInset)
        visibleBottom = offsetY + containerHeight - bottomInset
        self.offsetY = offsetY
        self.topInset = topInset
    }
    var isMeasured: Bool { visibleHeight > 0 }
}
