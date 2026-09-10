import Foundation
import ImageIO
import UniformTypeIdentifiers

extension CGImage {
  func pngData() -> Data? {
    let data = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        data,
        UTType.png.identifier as CFString,
        1, nil
      )
    else {
      return nil
    }

    CGImageDestinationAddImage(destination, self, nil)
    CGImageDestinationFinalize(destination)

    return data as Data
  }
}
