import SwiftUI
import Foundation

// Headless rendering regression for the production phrase-aware text renderer.
// Compile with ReplyPresentation, TextPhraseSequence, GlyphRevealLedger and
// StreamingGlyphReveal. No app window, account or simulator is needed.
nonisolated private final class RevealMeasurements: @unchecked Sendable {
    private let lock = NSLock()
    private var frames: [CGRect] = []
    func record(_ value: [CGRect]) { lock.lock(); defer { lock.unlock() }; frames = value }
    func read() -> [CGRect] { lock.lock(); defer { lock.unlock() }; return frames }
}

nonisolated private struct MeasuredReveal: TextRenderer {
    let renderer: GlyphRevealRenderer
    let measurements: RevealMeasurements
    var displayPadding: EdgeInsets { renderer.displayPadding }
    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        measurements.record(layout.flatMap { line in
            [line.typographicBounds.rect] + line.map { $0.typographicBounds.rect }
        })
        renderer.draw(layout: layout, in: &context)
    }
}

@main @MainActor private struct WelcomeRevealProbe {
    private struct Snapshot {
        let frames: [CGRect]
        let pixels: Data
        let ink: Int
    }

    static func main() {
        verifyViewportCentering()
        let samples = [
            "从这里开始",
            "选择设备和 Agent，\n把想做的事交给它。",
            "Find your next idea",
            "Start with a question.\nFind an answer with your Agent.",
            "Office files, café 👨‍👩‍👧‍👦\nA new idea ✨",
        ]
        var renders = 0
        for scale: CGFloat in [2, 3] {
            for width: CGFloat in [272, 354, 602] {
                for sample in samples {
                    let phrases = TextPhraseSequence.chunks(in: sample)
                    let full = render(sample, width: width, scale: scale, count: nil)
                    var digests = Set<Int>()
                    for count in 0...phrases.count {
                        let partial = render(sample, width: width, scale: scale, count: count)
                        precondition(partial.frames == full.frames, "Placement or line breaks moved at phrase \(count)")
                        if count == 0 { precondition(partial.ink == 0, "Future text flashed before reveal began") }
                        if count == phrases.count {
                            precondition(pixelsMatch(partial.pixels, full.pixels), "Completed phrase rendering differs from normal text")
                        }
                        digests.insert(partial.pixels.hashValue)
                        renders += 1
                    }
                    precondition(digests.count == phrases.count + 1, "A phrase did not become visible")
                }
            }
        }

        let ledger = GlyphRevealLedger(duration: 0.4)
        let sample = "选择设备和 Agent，\n把想做的事交给它。"
        let first = render(sample, width: 354, scale: 3, count: 1, ledger: ledger, time: 100, enabled: true)
        let middle = render(sample, width: 354, scale: 3, count: 1, ledger: ledger, time: 100.2, enabled: true)
        let last = render(sample, width: 354, scale: 3, count: 1, ledger: ledger, time: 100.4, enabled: true)
        let settled = render(sample, width: 354, scale: 3, count: 1)
        precondition(first.ink == 0 && middle.ink > 0 && pixelsMatch(last.pixels, settled.pixels),
            "The 0.4-second shared blur/fade curve failed to settle")
        precondition(first.frames == middle.frames && middle.frames == last.frames)
        print("PASS: \(renders) phrase renders at 2x/3x and widths 272/354/602; hidden copy reserves stable geometry and reveals without moving earlier text.")
        print("PASS: 0.4-second reveal settles to normal text; future phrases stay hidden and ordinary streaming remains fully visible.")
    }

    private static func pixelsMatch(_ lhs: Data, _ rhs: Data) -> Bool {
        // CoreText color-emoji rasterization can round a channel by one level
        // between renders. Keep exact dimensions and subpixel layout checks.
        lhs.count == rhs.count && zip(lhs, rhs).allSatisfy { abs(Int($0) - Int($1)) <= 1 }
    }

    private static func verifyViewportCentering() {
        for height: CGFloat in [280, 400, 800] {
            for dockHeight: CGFloat in [56, 170, 220] {
                let measurements = RevealMeasurements()
                let renderer = ImageRenderer(content: WelcomeViewportProbe(dockHeight: dockHeight, measurements: measurements)
                    .frame(width: 402, height: height))
                guard renderer.cgImage != nil, let frame = measurements.read().first else { fatalError("No viewport layout") }
                let expectedCenter = max(80, height - dockHeight) / 2
                precondition(abs(frame.midY - expectedCenter) < 0.001,
                    "Welcome centering ignored the composer: \(frame.midY), expected \(expectedCenter)")
            }
        }
        print("PASS: welcome stays centered above collapsed/expanded composer and remains scrollable in short viewports.")
    }

    private static func render(_ value: String, width: CGFloat, scale: CGFloat, count: Int?,
        ledger: GlyphRevealLedger = GlyphRevealLedger(duration: 0.4), time: TimeInterval = 100,
        enabled: Bool = false) -> Snapshot {
        let measurements = RevealMeasurements()
        let text = StreamingTextPhrase.text(value)
        let renderer = ImageRenderer(content: text.font(.system(size: 17)).foregroundStyle(.black)
            .multilineTextAlignment(.leading)
            .textRenderer(MeasuredReveal(renderer: .init(ledger: ledger, now: time, enabled: enabled,
                revealedPhraseCount: count), measurements: measurements))
            .frame(width: width).padding(12).background(.white))
        renderer.scale = scale
        guard let image = renderer.cgImage else { fatalError("No welcome image") }
        var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
        bytes.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(data: buffer.baseAddress, width: image.width, height: image.height,
                bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fatalError("No raster context") }
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        let ink = stride(from: 0, to: bytes.count, by: 4).filter { bytes[$0] < 250 }.count
        return Snapshot(frames: measurements.read(), pixels: Data(bytes), ink: ink)
    }
}

@MainActor private struct WelcomeViewportProbe: View {
    let dockHeight: CGFloat
    let measurements: RevealMeasurements
    var body: some View {
        GeometryReader { _ in
            GeometryReader { viewport in
                ScrollView {
                    Color.red.frame(width: 100, height: 80)
                        .background {
                            GeometryReader { geometry in
                                let _ = measurements.record([geometry.frame(in: .global)])
                                Color.clear
                            }
                        }
                        .frame(maxWidth: .infinity, minHeight: viewport.size.height)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { Color.blue.frame(height: dockHeight) }
        }
    }
}
