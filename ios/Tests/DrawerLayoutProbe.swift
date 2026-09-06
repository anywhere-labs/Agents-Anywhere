import SwiftUI
import AppKit

// A native, headless SwiftUI check for the phone card's render/layout boundary.
// Compile with SidebarDrawerTranslation.swift and SidebarDrawerCloseRegion.swift;
// no application window, simulator, account or network connection is needed.
@MainActor private final class Measurements {
    var frames: [CGRect] = []
}

@MainActor private struct Probe: View {
    let x: CGFloat
    let ignoresMotion: Bool
    let measurements: Measurements

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear
            Group {
                if ignoresMotion {
                    card.modifier(SidebarDrawerTranslation(x: x).ignoredByLayout())
                } else {
                    // The previous phone implementation, as a positive control.
                    card.geometryGroup().offset(x: x)
                }
            }
        }.frame(width: 750, height: 240)
    }

    private var card: some View {
        Color.red.frame(width: 402, height: 200)
            .overlay {
                GeometryReader { proxy in
                    let _ = measurements.frames.append(proxy.frame(in: .global))
                    Color.clear
                }
            }
    }
}

@main @MainActor private struct DrawerLayoutProbe {
    static func main() {
        verifyCloseHitRegion()
        var ordinaryOrigins = Set<CGFloat>()
        var stableOrigins = Set<CGFloat>()
        var stableWidths = Set<CGFloat>()
        var renderDigests = Set<Int>()
        for scale: CGFloat in [2, 3] {
            for x: CGFloat in [0, 0.1, 0.25, 0.5, 1.0 / 3, 17.123, 81.75, 199.888, 301.5, 302, -0.1] {
                for ignored in [false, true] {
                    let measurements = Measurements()
                    let renderer = ImageRenderer(content: Probe(x: x, ignoresMotion: ignored, measurements: measurements))
                    renderer.scale = scale
                    guard let image = renderer.cgImage, let bytes = image.dataProvider?.data else {
                        fatalError("Native SwiftUI renderer did not produce an image")
                    }
                    guard let frame = measurements.frames.last else { fatalError("No geometry measured") }
                    if ignored {
                        stableOrigins.insert(frame.minX)
                        stableWidths.insert(frame.width)
                        precondition(abs(frame.minX) < 0.001 && abs(frame.width - 402) < 0.001 && abs(frame.height - 200) < 0.001,
                            "Render translation leaked into layout: \(frame)")
                        renderDigests.insert((bytes as Data).hashValue)
                    } else {
                        ordinaryOrigins.insert(frame.minX)
                    }
                }
            }
        }
        precondition(ordinaryOrigins.count > 1, "Control did not expose movement")
        precondition(renderDigests.count > 2, "Translated card did not change its rendered position")
        print("PASS: 44 native SwiftUI renders at 2x/3x; ignored translation keeps origin 0 and size 402x200 while rendered positions change.")
        print("Control origins: \(ordinaryOrigins.count); isolated origins: \(stableOrigins.count); isolated widths: \(stableWidths.count).")
    }

    private static func verifyCloseHitRegion() {
        let bounds = CGRect(x: 0, y: 0, width: 402, height: 874)
        // Check the actual SwiftUI Path used by contentShape, not a duplicate
        // mathematical hit rule. Points in the sidebar must pass through it.
        for edge: CGFloat in [0.333333, 99.25, 201, 301.5, 350] {
            let path = SidebarDrawerCloseRegion(leadingEdge: edge).path(in: bounds)
            for y: CGFloat in [1, 200, 500, 873] {
                for x: CGFloat in [edge * 0.1, edge * 0.5, edge - 0.001] {
                    precondition(!path.contains(CGPoint(x: x, y: y)), "Close layer captured a sidebar tap")
                }
                for x: CGFloat in [edge + 0.001, (edge + bounds.width) / 2, 401.9] {
                    precondition(path.contains(CGPoint(x: x, y: y)), "Visible main-card tap could not close the drawer")
                }
            }
        }
        let shifted = SidebarDrawerCloseRegion(leadingEdge: 301.5)
            .path(in: CGRect(x: 20, y: 40, width: 402, height: 874))
        precondition(!shifted.contains(CGPoint(x: 200, y: 100)))
        precondition(shifted.contains(CGPoint(x: 350, y: 100)))
        print("PASS: close contentShape excludes sidebar points and includes only the exposed main card.")
    }
}
