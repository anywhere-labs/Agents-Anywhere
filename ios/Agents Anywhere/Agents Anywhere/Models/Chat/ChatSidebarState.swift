import Foundation

/// Selecting content dismisses an overlay, but preserves a regular-width split.
nonisolated struct ChatSidebarState: Equatable {
    enum Layout { case drawer, compactSplit, regularSplit }
    private(set) var layout = Layout.drawer
    var isOpen = false
    var obscuresDetail: Bool { layout != .regularSplit && isOpen }

    mutating func setLayout(_ next: Layout) {
        guard layout != next else { return }
        layout = next
        isOpen = next == .regularSplit
    }

    mutating func selectDestination() {
        if layout != .regularSplit { isOpen = false }
    }
}
