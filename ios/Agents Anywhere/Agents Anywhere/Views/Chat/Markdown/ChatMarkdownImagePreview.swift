import SwiftUI
import Textual
import UIKit

struct ChatMarkdownImagePreview: View {
    let attachment: AnyAttachment
    let title: String
    @State private var image: UIImage?
    @State private var loaded = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if let image {
                    ZoomableMarkdownImage(image: image).id(ObjectIdentifier(image))
                } else if loaded {
                    attachment.body.padding()
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle(title.isEmpty ? String(localized: "查看图片") : title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { SheetCloseToolbar { dismiss() } }
        }
        .appSheetPresentation(.expanded)
        .task(id: attachment) {
            let data = await Task.detached(priority: .userInitiated) { attachment.pngData() }.value
            guard !Task.isCancelled else { return }
            image = data.flatMap { UIImage(data: $0) }
            loaded = true
        }
    }
}

/// UIKit owns pinch-to-zoom, panning and bounce. Bounds changes preserve the
/// current zoom relative to the fitted image instead of adding SwiftUI gestures.
private struct ZoomableMarkdownImage: UIViewRepresentable {
    let image: UIImage
    func makeUIView(context: Context) -> ImageScrollView { ImageScrollView(image: image) }
    func updateUIView(_ view: ImageScrollView, context: Context) {}

    final class ImageScrollView: UIScrollView, UIScrollViewDelegate {
        private let imageView: UIImageView
        private var fittedBounds = CGSize.zero

        init(image: UIImage) {
            imageView = UIImageView(image: image)
            super.init(frame: .zero)
            delegate = self
            contentInsetAdjustmentBehavior = .never
            showsHorizontalScrollIndicator = false
            showsVerticalScrollIndicator = false
            bouncesZoom = true
            imageView.frame = CGRect(origin: .zero, size: image.size)
            addSubview(imageView)
            contentSize = image.size
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        override func layoutSubviews() {
            super.layoutSubviews()
            if bounds.size != fittedBounds, bounds.width > 0, bounds.height > 0,
               let size = imageView.image?.size, size.width > 0, size.height > 0 {
                let relativeZoom = fittedBounds == .zero ? 1 : zoomScale / minimumZoomScale
                fittedBounds = bounds.size
                let fit = min(bounds.width / size.width, bounds.height / size.height)
                minimumZoomScale = fit
                maximumZoomScale = fit * 6
                setZoomScale(min(maximumZoomScale, fit * relativeZoom), animated: false)
            }
            centerImage()
        }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
        func scrollViewDidZoom(_ scrollView: UIScrollView) { centerImage() }

        private func centerImage() {
            imageView.center = CGPoint(x: max(bounds.width, contentSize.width) / 2,
                y: max(bounds.height, contentSize.height) / 2)
        }
    }
}
