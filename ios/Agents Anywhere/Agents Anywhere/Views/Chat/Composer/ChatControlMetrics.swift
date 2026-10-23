import SwiftUI

/// True on the iPhone Duo (iPhone19,4), the only foldable so far. Read once:
/// a device does not change model at runtime. Simulators report the host arch
/// as the machine id, so they are identified through the model identifier the
/// simulator injects — that keeps the Duo simulator testable.
let isDuoFoldableIPhone: Bool = {
    #if targetEnvironment(simulator)
    ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] == "iPhone19,4"
    #else
    var system = utsname()
    uname(&system)
    let machine = withUnsafeBytes(of: &system.machine) {
        String(decoding: $0.prefix(while: { $0 != 0 }), as: UTF8.self)
    }
    return machine == "iPhone19,4"
    #endif
}()

/// One scale for the header circles and the collapsed composer. The visible
/// send circle is inset inside a full-size touch target, never the other way round.
struct ChatControlMetrics {
    static let collapsedHorizontalInset: CGFloat = 32
    static let expandedHorizontalInset: CGFloat = 12
    /// Readability cap for chat content on wide screens. The Duo's inner
    /// screen in landscape (~951pt) sits just above the 780pt cap and reads
    /// as letterboxed gaps, so foldables fill the width instead.
    static var maximumContentWidth: CGFloat { isDuoFoldableIPhone ? 2000 : 780 }
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
