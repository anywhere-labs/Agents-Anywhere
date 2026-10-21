// Run with ios/scripts/probe-drawer-updates.py. It compiles a temporary copy of
// the real drawer with an externally driven progress binding, then renders it
// without a window or simulator. Rendering counters do not measure device FPS.
import SwiftUI
import UIKit
import Observation

@MainActor @Observable final class DrawerProbeDriver { var destination = 0 }
@MainActor enum DrawerProbeControl {
    static let driver = DrawerProbeDriver()
    static let motion = SidebarDrawerMotion(progress: 0)
    static var containerBodies = 0
}
@MainActor final class Counts {
    var header = 0; var sidebar = 0; var main = 0; var bodies = 0; var sidebarBodies = 0
    var pageLayouts = 0; var sidebarLayouts = 0
}
@MainActor struct CountingLayout: @preconcurrency Layout {
    let counts: Counts; let sidebar: Bool
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        if sidebar { counts.sidebarLayouts += 1 } else { counts.pageLayouts += 1 }
        return subviews.first?.sizeThatFits(proposal) ?? .zero
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        if sidebar { counts.sidebarLayouts += 1 } else { counts.pageLayouts += 1 }
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
    }
}
struct ClosurePage: View {
    let counts: Counts
    let onSelect: (Int) -> Void
    let sessions: [String]
    var body: some View {
        let _ = { counts.sidebarBodies += 1 }()
        CountingLayout(counts: counts, sidebar: true) { ScrollView { VStack { ForEach(sessions, id: \.self) { Text($0) } } } }
    }
}
struct CountedPage: View {
    let counts: Counts
    let destination: Int
    var body: some View {
        let _ = { counts.bodies += 1 }()
        CountingLayout(counts: counts, sidebar: false) { ScrollView { VStack { ForEach(0..<30, id: \.self) { Text("Page \(destination), paragraph \($0)") } } } }
    }
}
struct Root: View {
    let counts: Counts
    var body: some View {
        let destination = DrawerProbeControl.driver.destination
        SidebarDrawer(isOpen: .constant(false), presentation: .drawer, configuration: .chat) { _ in
            let _ = { counts.header += 1 }()
            Text("Header").frame(height: 56)
        } sidebar: { _ in
            let _ = { counts.sidebar += 1 }()
            ClosurePage(counts: counts, onSelect: { _ in }, sessions: (0..<50).map { "Session \($0)" })
        } content: { _ in
            let _ = { counts.main += 1 }()
            CountedPage(counts: counts, destination: destination).id(destination)
        }
    }
}
@main @MainActor struct DrawerUpdateProbe {
    static func main() {
        let counts = Counts()
        let renderer = ImageRenderer(content: Root(counts: counts).frame(width: 402, height: 874))
        renderer.scale = 0.25
        func update() {
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.005))
            precondition(renderer.cgImage != nil)
        }
        update()
        let closedLayouts = (counts.pageLayouts, counts.sidebarLayouts)
        DrawerProbeControl.motion.move(to: 0.05); update()
        print("layout passes leaving closed: page \(counts.pageLayouts - closedLayouts.0), sidebar \(counts.sidebarLayouts - closedLayouts.1)")
        DrawerProbeControl.motion.move(to: 0.1); update()
        let containerBodies = DrawerProbeControl.containerBodies
        precondition(containerBodies > 0, "The probe did not count the drawer container")
        let initial = (counts.header, counts.sidebar, counts.main)
        let layouts = (counts.pageLayouts, counts.sidebarLayouts)
        for step in 1...120 { DrawerProbeControl.motion.move(to: 0.1 + 0.8 * CGFloat(step) / 120); update() }
        for step in 1...120 { DrawerProbeControl.motion.move(to: 0.9 - 0.8 * CGFloat(step) / 120); update() }
        precondition(initial.0 > 0 && initial.1 > 0 && initial.2 > 0, "The renderer did not mount the drawer")
        precondition((counts.header, counts.sidebar, counts.main) == initial,
            "A pan sample invoked a page factory")
        precondition(DrawerProbeControl.containerBodies == containerBodies,
            "A pan sample re-evaluated the drawer container (\(DrawerProbeControl.containerBodies - containerBodies) times)")
        print("layout passes during 240 samples: page \(counts.pageLayouts - layouts.0), sidebar \(counts.sidebarLayouts - layouts.1)")
        print("PASS: 240 drag samples without additional header/sidebar/detail builds; page body evaluations \(counts.bodies), sidebar body evaluations \(counts.sidebarBodies).")
        let before = counts.main
        DrawerProbeControl.driver.destination += 1; update()
        precondition(counts.main > before, "Destination change did not update the content")
        print("PASS: a real destination change still updates the detail.")
    }
}
