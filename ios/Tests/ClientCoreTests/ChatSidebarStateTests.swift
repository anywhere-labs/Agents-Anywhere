import Testing
@testable import ClientCore

@Suite struct ChatSidebarStateTests {
    @Test func regularSplitStartsOpenAndNavigationKeepsBothColumnsVisible() {
        var sidebar = ChatSidebarState()
        sidebar.setLayout(.regularSplit)
        #expect(sidebar.isOpen && !sidebar.obscuresDetail)
        for _ in 0..<3 {
            sidebar.selectDestination()
            #expect(sidebar.isOpen && !sidebar.obscuresDetail)
        }
    }

    @Test func phoneAndCompactIPadDismissTheOverlayAfterSelection() {
        for layout in [ChatSidebarState.Layout.drawer, .compactSplit] {
            var sidebar = ChatSidebarState()
            sidebar.setLayout(layout)
            sidebar.isOpen = true
            #expect(sidebar.obscuresDetail)
            sidebar.selectDestination()
            #expect(!sidebar.isOpen && !sidebar.obscuresDetail)
        }
    }

    @Test func resizingRestoresRegularSplitWithoutUndoingAnExplicitToggle() {
        var sidebar = ChatSidebarState()
        sidebar.setLayout(.regularSplit)
        sidebar.isOpen = false
        sidebar.setLayout(.regularSplit)
        sidebar.selectDestination()
        #expect(!sidebar.isOpen && !sidebar.obscuresDetail)
        sidebar.setLayout(.compactSplit)
        sidebar.isOpen = true
        #expect(sidebar.obscuresDetail)
        sidebar.setLayout(.regularSplit)
        #expect(sidebar.isOpen && !sidebar.obscuresDetail)
        sidebar.setLayout(.compactSplit)
        #expect(!sidebar.isOpen)
    }
}
