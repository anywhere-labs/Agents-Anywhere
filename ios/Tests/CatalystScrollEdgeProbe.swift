import UIKit

// Compile for Mac Catalyst alongside ChatPageScrollEdge.swift. This exercises
// real UIKit containment without launching the app, a window or a simulator.
@main @MainActor private struct CatalystScrollEdgeProbe {
    @MainActor private final class Page {
        let controller = UIViewController()
        let scroll = UIScrollView(frame: CGRect(x: 0, y: 0, width: 800, height: 600))
        let editor = UITextView()
        let marker = ChatPageScrollEdgeController()
        let nestedController = UIViewController()

        init() {
            controller.loadViewIfNeeded()
            controller.view.frame = scroll.frame
            let geometryContainer = UIView(frame: scroll.frame)
            controller.view.addSubview(geometryContainer)
            geometryContainer.addSubview(scroll)
            controller.view.addSubview(editor)
            scroll.contentSize = CGSize(width: 800, height: 1600)
            scroll.contentInset = UIEdgeInsets(top: 16, left: 0, bottom: 72, right: 0)
            scroll.contentOffset = CGPoint(x: 0, y: 320)
            controller.setContentScrollView(editor, for: .bottom)

            controller.addChild(nestedController)
            nestedController.didMove(toParent: controller)
            attach(marker)
        }

        func attach(_ marker: ChatPageScrollEdgeController) {
            nestedController.addChild(marker)
            marker.view.frame = scroll.bounds
            scroll.addSubview(marker.view)
            marker.didMove(toParent: nestedController)
        }

        func layout() {
            marker.view.setNeedsLayout()
            marker.view.layoutIfNeeded()
        }
    }

    static func main() {
        let sidebar = Page()
        let sidebarNavigation = UINavigationController(rootViewController: sidebar.controller)
        sidebar.layout()
        let detail = Page()
        let detailNavigation = UINavigationController(rootViewController: detail.controller)
        let originalOffset = detail.scroll.contentOffset
        let originalInset = detail.scroll.contentInset
        detail.layout()

        precondition(detail.controller.contentScrollView(for: .top) === detail.scroll)
        precondition(detail.scroll.topEdgeEffect.style === UIScrollEdgeEffect.Style.soft)
        precondition(detail.controller.contentScrollView(for: .bottom) === detail.editor)
        precondition(sidebar.controller.contentScrollView(for: .top) === sidebar.scroll)
        precondition(detail.scroll.contentOffset == originalOffset && detail.scroll.contentInset == originalInset)
        print("PASS: nested detail registers its primary scroll with native soft styling; sidebar, editor and reading position stay independent.")

        let replacement = ChatPageScrollEdgeController()
        let replacementScroll = UIScrollView(frame: detail.scroll.frame)
        detail.controller.view.addSubview(replacementScroll)
        detail.nestedController.addChild(replacement)
        replacement.view.frame = replacementScroll.bounds
        replacementScroll.addSubview(replacement.view)
        replacement.didMove(toParent: detail.nestedController)
        replacement.view.layoutIfNeeded()
        precondition(detail.controller.contentScrollView(for: .top) === replacementScroll)
        detail.layout()
        precondition(detail.controller.contentScrollView(for: .top) === replacementScroll)
        detail.marker.stopRegistration()
        precondition(detail.controller.contentScrollView(for: .top) === replacementScroll)
        replacement.stopRegistration()
        precondition(detail.controller.contentScrollView(for: .top) == nil)
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
        precondition(detail.controller.contentScrollView(for: .top) == nil)
        print("PASS: removal cannot erase a newer registration or re-register from a queued update.")

        let nextPage = Page()
        detailNavigation.setViewControllers([detail.controller, nextPage.controller], animated: false)
        nextPage.layout()
        precondition(nextPage.controller.contentScrollView(for: .top) === nextPage.scroll)
        let inactiveMarker = ChatPageScrollEdgeController()
        detail.attach(inactiveMarker)
        inactiveMarker.view.layoutIfNeeded()
        precondition(detail.controller.contentScrollView(for: .top) == nil)
        precondition(nextPage.controller.contentScrollView(for: .top) === nextPage.scroll)
        print("PASS: inactive navigation pages cannot reclaim the visible page's scroll edge.")

        withExtendedLifetime([sidebarNavigation, detailNavigation]) {}
    }
}
