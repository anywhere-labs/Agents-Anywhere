import Foundation

/// Selecting content dismisses an overlay, but preserves a regular-width split.
nonisolated struct ChatSidebarState: Equatable {
    enum Layout {
        case drawer, regularSplit

        static func resolve(isPad: Bool, hasRegularWidth: Bool) -> Layout {
            isPad && hasRegularWidth ? .regularSplit : .drawer
        }
    }
    private(set) var layout = Layout.drawer
    var isOpen = false
    var obscuresDetail: Bool { layout != .regularSplit && isOpen }

    func isOpen(in next: Layout) -> Bool {
        // A newly mounted navigation host needs its destination state before
        // onChange commits the new layout, otherwise a narrow window flashes
        // an open drawer and immediately animates it closed.
        layout == next ? isOpen : next == .regularSplit
    }

    mutating func setLayout(_ next: Layout) {
        guard layout != next else { return }
        isOpen = isOpen(in: next)
        layout = next
    }

    mutating func selectDestination() {
        if layout != .regularSplit { isOpen = false }
    }
}
