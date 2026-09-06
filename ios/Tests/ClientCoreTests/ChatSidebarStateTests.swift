import Testing
@testable import ClientCore

@Suite struct ChatSidebarStateTests {
    @Test func systemSizeClassDeterminesIPadSidebarAvailability() {
        #expect(ChatSidebarState.Layout.resolve(isPad: true, hasRegularWidth: true) == .regularSplit)
        #expect(ChatSidebarState.Layout.resolve(isPad: true, hasRegularWidth: false) == .drawer)
        for hasRegularWidth in [true, false] {
            #expect(ChatSidebarState.Layout.resolve(isPad: false, hasRegularWidth: hasRegularWidth) == .drawer)
        }
    }

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
        for isPad in [false, true] {
            let layout = ChatSidebarState.Layout.resolve(isPad: isPad, hasRegularWidth: false)
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
        sidebar.setLayout(.drawer)
        sidebar.isOpen = true
        #expect(sidebar.obscuresDetail)
        sidebar.setLayout(.regularSplit)
        #expect(sidebar.isOpen && !sidebar.obscuresDetail)
        sidebar.setLayout(.drawer)
        #expect(!sidebar.isOpen)
    }

    @Test func resizedHostGetsItsOpenStateBeforeTheLayoutChangeIsCommitted() {
        var sidebar = ChatSidebarState()
        sidebar.setLayout(.regularSplit)
        #expect(!sidebar.isOpen(in: .drawer))
        sidebar.setLayout(.drawer)
        #expect(!sidebar.isOpen)
        #expect(sidebar.isOpen(in: .regularSplit))
        sidebar.setLayout(.regularSplit)
        #expect(sidebar.isOpen)
        sidebar.isOpen = false
        #expect(!sidebar.isOpen(in: .regularSplit))
    }

    @Test func openPhoneDrawerDisablesTheUntranslatedPageAndEnablesSidebarActions() {
        let interaction = DrawerInteractionState(isOpen: true, progress: 1, isAnimating: false, isDragging: false)
        #expect(interaction.acceptsSidebarTouches)
        #expect(!interaction.acceptsContentTouches)
    }

    @Test func closingAfterSelectionWaitsForTheSpringBeforeEnablingThePage() {
        // isOpen and progress already contain their destination values while
        // the spring is still drawing the main card over part of the sidebar.
        let closing = DrawerInteractionState(isOpen: false, progress: 0, isAnimating: true, isDragging: false)
        #expect(!closing.acceptsContentTouches && !closing.acceptsSidebarTouches)
        let closed = DrawerInteractionState(isOpen: false, progress: 0, isAnimating: false, isDragging: false)
        #expect(closed.acceptsContentTouches && !closed.acceptsSidebarTouches)
    }

    @Test func interruptedAndUnsettledPansCannotActivateEitherSurface() {
        let states = [
            DrawerInteractionState(isOpen: true, progress: 1, isAnimating: true, isDragging: false),
            DrawerInteractionState(isOpen: true, progress: 1, isAnimating: false, isDragging: true),
            DrawerInteractionState(isOpen: false, progress: 0, isAnimating: false, isDragging: true),
            DrawerInteractionState(isOpen: true, progress: 0.6, isAnimating: false, isDragging: false),
            DrawerInteractionState(isOpen: false, progress: 0.4, isAnimating: false, isDragging: false),
        ]
        for state in states {
            #expect(!state.acceptsContentTouches && !state.acceptsSidebarTouches)
        }
    }
}
