// Run with ios/scripts/probe-drawer-updates.py. It compiles a temporary copy of
// the real drawer with an externally driven progress binding, then renders it
// without a window or simulator. Rendering counters do not measure device FPS.
import SwiftUI
import UIKit
import Observation

@MainActor @Observable final class DrawerProbeDriver { var value: CGFloat = 0.1; var destination = 0 }
@MainActor enum DrawerProbeControl {
    static let driver = DrawerProbeDriver()
    static let progress = Binding<CGFloat>(get: { driver.value }, set: { driver.value = $0 })
}
@MainActor final class Counts {
    var header = 0; var sidebar = 0; var main = 0; var bodies = 0
}
struct CountedPage: View {
    let counts: Counts
    let destination: Int
    var body: some View {
        let _ = { counts.bodies += 1 }()
        ScrollView { VStack { ForEach(0..<30, id: \.self) { Text("Page \(destination), paragraph \($0)") } } }
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
            ScrollView { VStack { ForEach(0..<50, id: \.self) { Text("Session \($0)") } } }
        } content: { _ in
            let _ = { counts.main += 1 }()
            CountedPage(counts: counts, destination: destination).id(destination)
        }
    }
}
@main @MainActor struct DrawerUpdateProbe {
    static func main() {
        _ = DrawerProbeControl.progress
        let counts = Counts()
        let renderer = ImageRenderer(content: Root(counts: counts).frame(width: 402, height: 874))
        renderer.scale = 0.25
        func update() {
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.005))
            precondition(renderer.cgImage != nil)
        }
        update()
        let initial = (counts.header, counts.sidebar, counts.main)
        for step in 1...120 { DrawerProbeControl.driver.value = 0.1 + 0.8 * CGFloat(step) / 120; update() }
        for step in 1...120 { DrawerProbeControl.driver.value = 0.9 - 0.8 * CGFloat(step) / 120; update() }
        precondition(initial.0 > 0 && initial.1 > 0 && initial.2 > 0, "The renderer did not mount the drawer")
        precondition((counts.header, counts.sidebar, counts.main) == initial,
            "A pan sample invoked a page factory")
        print("PASS: 240 drag samples without additional header/sidebar/detail builds; page body evaluations \(counts.bodies).")
        let before = counts.main
        DrawerProbeControl.driver.destination += 1; update()
        precondition(counts.main > before, "Destination change did not update the content")
        print("PASS: a real destination change still updates the detail.")
    }
}
