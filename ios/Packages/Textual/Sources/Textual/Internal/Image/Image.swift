import Foundation
import ImageIO

// MARK: - Overview
//
// Image decodes static and animated images from data using CGImageSource. Supports GIF, APNG,
// WebP, and HEICS animation formats.
//
// Frame delay times follow WebKit's approach: prefer unclamped delay time if available, and
// enforce a minimum 100ms delay for any frames specifying ≤10ms (prevents CPU-intensive
// animations with extremely short frame durations).

struct Image: Hashable, Sendable {
  struct Frame: Hashable, Sendable {
    var cgImage: CGImage
    var delayTime: TimeInterval
  }

  var frames: [Frame]
  var loopCount: Int
  var size: CGSize

  var cgImage: CGImage { frames[0].cgImage }
  var isAnimated: Bool { frames.count > 1 }
}

extension Image {
  init?(data: Data) {
    guard let cgImageSource = CGImageSourceCreateWithData(data as CFData, nil) else {
      return nil
    }

    switch CGImageSourceGetCount(cgImageSource) {
    case 0:
      return nil
    case 1:
      guard let cgImage = CGImageSourceCreateImageAtIndex(cgImageSource, 0, nil) else {
        return nil
      }
      self.init(cgImage: cgImage)
    default:
      self.init(cgImageSource: cgImageSource)
    }
  }

  private init(cgImage: CGImage) {
    self.init(
      frames: [.init(cgImage: cgImage, delayTime: 0)],
      loopCount: 0,
      size: .init(width: cgImage.width, height: cgImage.height)
    )
  }

  private init?(cgImageSource: CGImageSource) {
    guard
      let animationProperties = cgImageSource.animationProperties,
      let frameInfo = animationProperties[.frameInfo]
    else {
      return nil
    }

    let images = (0..<CGImageSourceGetCount(cgImageSource))
      .compactMap { index in
        CGImageSourceCreateImageAtIndex(cgImageSource, index, nil)
      }

    guard !images.isEmpty else {
      return nil
    }

    let delayTimes = frameInfo.map { dictionary in
      // https://github.com/WebKit/WebKit/blob/93e79e70eb8a91d957ef15914f9ae8b7776cee54/Source/WebCore/platform/graphics/cg/ImageDecoderCG.cpp#L503
      // Use the unclamped frame delay if it exists. Otherwise use the clamped frame delay.
      let value = dictionary[.unclampedDelayTime] ?? dictionary[.delayTime] ?? 0
      // Use a duration of 100 ms for any frames that specify a duration of <= 10 ms.
      return value > 0.010 ? value : 0.1
    }

    let canvasWidth = animationProperties[.canvasPixelWidth]
    let canvasHeight = animationProperties[.canvasPixelHeight]

    let size =
      if let canvasWidth, let canvasHeight {
        CGSize(width: canvasWidth, height: canvasHeight)
      } else {
        CGSize(width: images[0].width, height: images[0].height)
      }

    self.init(
      frames: zip(images, delayTimes).map(Frame.init),
      loopCount: animationProperties[.loopCount] ?? 0,
      size: size
    )
  }
}

extension CGImageSource {
  fileprivate struct ImageProperty<Value>: Sendable {
    let key: String
  }

  fileprivate var animationProperties: CFDictionary? {
    guard let properties = CGImageSourceCopyProperties(self, nil) else {
      return nil
    }

    return properties[.gifDictionary] ?? properties[.pngDictionary]
      ?? properties[.webPDictionary] ?? properties[.heicsDictionary]
  }
}

extension CFDictionary {
  fileprivate subscript<Value>(_ imageProperty: CGImageSource.ImageProperty<Value>) -> Value? {
    (self as NSDictionary).object(forKey: imageProperty.key) as? Value
  }
}

extension CGImageSource.ImageProperty where Value == CFDictionary {
  fileprivate static let gifDictionary = Self(key: kCGImagePropertyGIFDictionary as String)
  fileprivate static let pngDictionary = Self(key: kCGImagePropertyPNGDictionary as String)
  fileprivate static let webPDictionary = Self(key: kCGImagePropertyWebPDictionary as String)
  fileprivate static let heicsDictionary = Self(key: kCGImagePropertyHEICSDictionary as String)
}

extension CGImageSource.ImageProperty where Value == [CFDictionary] {
  static let frameInfo = Self(key: "FrameInfo")
}

extension CGImageSource.ImageProperty where Value == TimeInterval {
  static let delayTime = Self(key: "DelayTime")
  static let unclampedDelayTime = Self(key: "UnclampedDelayTime")
}

extension CGImageSource.ImageProperty where Value == Int {
  static let loopCount = Self(key: "LoopCount")
}

extension CGImageSource.ImageProperty where Value == CGFloat {
  static let canvasPixelWidth = Self(key: "CanvasPixelWidth")
  static let canvasPixelHeight = Self(key: "CanvasPixelHeight")
}
