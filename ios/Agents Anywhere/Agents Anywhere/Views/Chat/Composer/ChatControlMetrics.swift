import SwiftUI

/// One scale for the header circles and the collapsed composer. The visible
/// send circle is inset inside a full-size touch target, never the other way round.
struct ChatControlMetrics {
    static let collapsedHorizontalInset: CGFloat = 32
    static let expandedHorizontalInset: CGFloat = 12
    static let maximumContentWidth: CGFloat = 780
    let diameter: CGFloat

    init(bodyLineHeight: CGFloat) {
        diameter = max(48, ceil(bodyLineHeight) + 12)
    }

    var touchTarget: CGFloat { max(44, diameter - 4) }
    var sendDiameter: CGFloat { touchTarget - 8 }
    var collapsedInset: CGFloat { (diameter - touchTarget) / 2 }
    var collapsedCornerRadius: CGFloat { diameter / 2 }
    var expandedCornerRadius: CGFloat { diameter / 2 + 2 }
    let textInset: CGFloat = 16
    let textToActions: CGFloat = 10
    let expandedBottomInset: CGFloat = 8
    let collapsedTextGap: CGFloat = 4
}
