import CoreGraphics
import UIKit

enum AccountAvatarProcessingError: LocalizedError {
    case invalidImage
    case imageTooLarge
    case encodingFailed

    var errorDescription: String? {
        switch self {
        case .invalidImage:
            String(localized: "The selected file is not a supported image.")
        case .imageTooLarge:
            String(localized: "Choose an image smaller than 8 MB.")
        case .encodingFailed:
            String(localized: "The avatar image could not be prepared.")
        }
    }
}

struct AccountAvatarProcessor {
    static let outputSize: CGFloat = 256
    static let maximumInputBytes = 8 * 1024 * 1024

    static func image(from data: Data) throws -> UIImage {
        guard data.count <= maximumInputBytes else {
            throw AccountAvatarProcessingError.imageTooLarge
        }
        guard let image = UIImage(data: data), image.size.width > 0, image.size.height > 0 else {
            throw AccountAvatarProcessingError.invalidImage
        }
        return image
    }

    static func clampedOffset(image: UIImage, zoom: CGFloat, candidate: CGSize) -> CGSize {
        let drawSize = scaledImageSize(image: image, zoom: zoom)
        let maximumX = max((drawSize.width - outputSize) / 2, 0)
        let maximumY = max((drawSize.height - outputSize) / 2, 0)
        return CGSize(
            width: min(max(candidate.width, -maximumX), maximumX),
            height: min(max(candidate.height, -maximumY), maximumY)
        )
    }

    static func dataURL(image: UIImage, zoom: CGFloat, offset: CGSize) throws -> String {
        let normalizedZoom = min(max(zoom, 1), 3)
        let normalizedOffset = clampedOffset(
            image: image,
            zoom: normalizedZoom,
            candidate: offset
        )
        let drawSize = scaledImageSize(image: image, zoom: normalizedZoom)
        let drawOrigin = CGPoint(
            x: (outputSize - drawSize.width) / 2 + normalizedOffset.width,
            y: (outputSize - drawSize.height) / 2 + normalizedOffset.height
        )
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(
            size: CGSize(width: outputSize, height: outputSize),
            format: format
        )
        let output = renderer.image { context in
            UIColor.systemBackground.setFill()
            context.cgContext.fill(
                CGRect(
                    origin: .zero,
                    size: CGSize(width: outputSize, height: outputSize)
                )
            )
            image.draw(in: CGRect(origin: drawOrigin, size: drawSize))
        }
        guard let data = output.jpegData(compressionQuality: 0.88) else {
            throw AccountAvatarProcessingError.encodingFailed
        }
        return "data:image/jpeg;base64,\(data.base64EncodedString())"
    }

    private static func scaledImageSize(image: UIImage, zoom: CGFloat) -> CGSize {
        let fillScale = max(outputSize / image.size.width, outputSize / image.size.height)
        let scale = fillScale * min(max(zoom, 1), 3)
        return CGSize(width: image.size.width * scale, height: image.size.height * scale)
    }
}
