import Foundation

/// Layout-local height reservations, keyed by the parent's width proposal.
/// A paragraph's intrinsic width is an output, never the next layout's input.
struct MarkdownBlockSizing {
    private struct Measurement {
        let width: CGFloat
        var height: CGFloat
    }
    private var measurements: [Measurement] = []

    /// - Parameter monotonic: 同一宽度下取历史最大高度。流式追加时防止块高
    ///   回缩造成跳动；**非流式全文**（文档阅读）必须关掉，否则某个宽度下
    ///   测出的偏大高度会被永久保留，换宽度时表现为随宽度变化的空白。
    mutating func size(
        proposedWidth: CGFloat?,
        naturalSize: CGSize,
        displayScale: CGFloat,
        monotonic: Bool = true
    ) -> CGSize {
        // SwiftUI may ask for minimum/ideal sizes before placing the block.
        // Those probes must not replace the reservation for its actual column.
        guard let width = proposedWidth, width.isFinite, width > 1 else { return naturalSize }
        let scale = displayScale.isFinite && displayScale > 0 ? displayScale : 1
        let naturalHeight = naturalSize.height.isFinite ? max(0, naturalSize.height) : 0
        var height = ceil(naturalHeight * scale) / scale
        if monotonic, let index = measurements.firstIndex(where: { $0.width == width }) {
            height = max(height, measurements.remove(at: index).height)
        } else {
            measurements.removeAll { $0.width == width }
        }
        measurements.append(Measurement(width: width, height: height))
        // Keep measurement probes separate without accumulating every width
        // visited by an interactive iPad split resize.
        if measurements.count > 8 { measurements.removeFirst() }
        return CGSize(width: width, height: height)
    }
}

/// Cache actual child measurements separately from the monotonic height reservation.
/// Layout.updateCache invalidates these when subviews or their environment change.
struct MarkdownMeasurementCache {
    private struct Measurement {
        let width: CGFloat?
        let size: CGSize
    }
    private var measurements: [Measurement] = []

    mutating func size(proposedWidth: CGFloat?, measure: () -> CGSize) -> CGSize {
        if let cached = measurements.first(where: { $0.width == proposedWidth }) { return cached.size }
        let result = measure()
        measurements.append(Measurement(width: proposedWidth, size: result))
        if measurements.count > 8 { measurements.removeFirst() }
        return result
    }

    mutating func invalidate() { measurements.removeAll(keepingCapacity: true) }
}
