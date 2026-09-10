#if canImport(UIKit)
import SwiftUI
import UIKit

// Establishes horizontal intent before recognition so drawer pans cancel row taps without stealing vertical scrolling.
struct SidebarDrawerPanGesture: UIGestureRecognizerRepresentable {
    let progress: CGFloat
    let edgeActivationWidth: CGFloat
    let onBegan: () -> Void
    let onChanged: (CGFloat) -> Void
    let onEnded: (CGFloat, CGFloat, Bool) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator {
        Coordinator()
    }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let recognizer = UIPanGestureRecognizer()
        recognizer.cancelsTouchesInView = true
        recognizer.maximumNumberOfTouches = 1
        recognizer.delegate = context.coordinator
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: UIPanGestureRecognizer, context: Context) {
        context.coordinator.progress = progress
        context.coordinator.edgeActivationWidth = max(edgeActivationWidth, 0)
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
        let translationX = context.converter.localTranslation?.x ?? 0
        let velocityX = context.converter.localVelocity?.x ?? 0

        switch recognizer.state {
        case .began:
            onBegan()
        case .changed:
            onChanged(translationX)
        case .ended:
            onEnded(translationX, velocityX, false)
        case .cancelled:
            onEnded(translationX, velocityX, true)
        case .possible, .failed:
            break
        @unknown default:
            break
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var progress: CGFloat = 0
        var edgeActivationWidth: CGFloat = 0

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard
                let pan = gestureRecognizer as? UIPanGestureRecognizer,
                let view = pan.view
            else {
                return false
            }

            let velocity = pan.velocity(in: view)
            guard abs(velocity.x) > abs(velocity.y) else { return false }

            if progress <= 0.001 {
                let translation = pan.translation(in: view)
                let initialX = pan.location(in: view).x - translation.x
                return initialX <= edgeActivationWidth && velocity.x > 0
            }

            if progress >= 0.999 {
                return velocity.x < 0
            }

            return true
        }
    }
}
#endif
