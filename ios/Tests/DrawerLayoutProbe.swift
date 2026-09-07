import SwiftUI
import AppKit

// A native, headless SwiftUI check for the phone card's render/layout boundary.
// Compile with SidebarDrawerTranslation.swift, SidebarDrawerScale.swift and SidebarDrawerCloseRegion.swift;
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
        verifySidebarScale()
        verifySharedSidebarPivot()
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

    private static func verifySidebarScale() {
        var originalTops = Set<CGFloat>()
        var digests = Set<Int>()
        for displayScale: CGFloat in [2, 3] {
            // Include both sides of the identity transform and the spring's
            // final fractional frames, where UIKit used to adjust its inset.
            for scale: CGFloat in [0.95, 0.975, 0.99, 0.999, 0.9999, 1, 1.0001] {
                for ignored in [false, true] {
                    let measurements = Measurements()
                    let renderer = ImageRenderer(content: SidebarScaleProbe(
                        scale: scale, ignoresMotion: ignored, measurements: measurements))
                    renderer.scale = displayScale
                    guard let image = renderer.cgImage, let bytes = image.dataProvider?.data,
                          let frame = measurements.frames.last else { fatalError("No sidebar render or geometry") }
                    if ignored {
                        precondition(abs(frame.minY) < 0.001 && abs(frame.width - 302) < 0.001 && abs(frame.height - 874) < 0.001,
                            "Sidebar scale leaked into navigation layout: \(frame)")
                        digests.insert((bytes as Data).hashValue)
                    } else { originalTops.insert(frame.minY) }
                }
            }
        }
        precondition(originalTops.count > 1, "Scale control did not expose vertical movement")
        precondition(digests.count > 2, "Sidebar scale animation stopped rendering")
        print("PASS: 28 sidebar renders at 2x/3x; layout stays 302x874 at y=0 through the identity transform while the reveal still scales.")
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

    private static func verifySharedSidebarPivot() {
        for size in [CGSize(width: 302, height: 874), CGSize(width: 240, height: 500)] {
            // Deliberately asymmetric bars: the list center differs from the
            // whole surface center, including after a compact-window resize.
            let viewport = CGRect(x: 0, y: 96, width: size.width, height: size.height - 150)
            let pivot = CGPoint(x: viewport.midX, y: viewport.midY)
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let anchor = UnitPoint(x: pivot.x / size.width, y: pivot.y / size.height)
            let row = CGPoint(x: 24, y: viewport.minY + 80)
            let controls = [CGPoint(x: 50, y: size.height - 60),
                CGPoint(x: size.width - 40, y: size.height - 60)]
            for scale: CGFloat in [0.95, 0.975, 0.9999, 1, 1.0001] {
                let effect = SidebarDrawerScale(scale: scale, anchor: anchor)
                let nativeTransform = effect.viewTransform(size: size)
                func nativePoint(_ point: CGPoint) -> CGPoint {
                    // UIKit transforms coordinates around UIView's bounds center.
                    let relative = CGPoint(x: point.x - center.x, y: point.y - center.y)
                        .applying(nativeTransform)
                    return CGPoint(x: relative.x + center.x, y: relative.y + center.y)
                }
                func near(_ actual: CGPoint, _ expected: CGPoint) -> Bool {
                    abs(actual.x - expected.x) < 0.0001 && abs(actual.y - expected.y) < 0.0001
                }
                precondition(near(nativePoint(pivot), pivot), "List viewport pivot moved during scaling")
                let renderedRow = nativePoint(row)
                for control in controls {
                    let renderedControl = nativePoint(control)
                    precondition(near(
                        CGPoint(x: renderedControl.x - renderedRow.x, y: renderedControl.y - renderedRow.y),
                        CGPoint(x: (control.x - row.x) * scale, y: (control.y - row.y) * scale)
                    ), "Toolbar control moved independently of its list")
                }
                // The existing SwiftUI geometry effect and the UIKit surface
                // must agree despite their different transform origins.
                let projection = effect.effectValue(size: size)
                for point in [pivot, row] + controls {
                    let projected = CGPoint(x: point.x * projection.m11 + projection.m31,
                        y: point.y * projection.m22 + projection.m32)
                    precondition(near(nativePoint(point), projected), "Native and SwiftUI transforms disagree")
                }
            }
        }
        print("PASS: list viewport pivot stays fixed; both toolbar controls share the list transform through scaling and resize.")
    }
}

@MainActor private struct SidebarScaleProbe: View {
    let scale: CGFloat
    let ignoresMotion: Bool
    let measurements: Measurements

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear
            if ignoresMotion {
                sidebar.modifier(SidebarDrawerScale(scale: scale).ignoredByLayout())
            } else {
                sidebar.scaleEffect(scale, anchor: .leading)
            }
        }.frame(width: 402, height: 874)
    }

    private var sidebar: some View {
        Color.red.frame(width: 302, height: 874)
            .overlay {
                GeometryReader { proxy in
                    let _ = measurements.frames.append(proxy.frame(in: .global))
                    Color.clear
                }
            }
    }
}
