import Foundation
import UniformTypeIdentifiers

final class TransferableText: NSObject {
  let attributedString: NSAttributedString

  private let formatter: Formatter

  init(attributedString: NSAttributedString) {
    self.attributedString = attributedString
    self.formatter = Formatter(attributedString)
    super.init()
  }
}

extension TransferableText: NSItemProviderWriting {
  static var writableTypeIdentifiersForItemProvider: [String] {
    [UTType.plainText.identifier, UTType.html.identifier]
  }

  func loadData(
    withTypeIdentifier typeIdentifier: String,
    forItemProviderCompletionHandler completionHandler: @escaping (Data?, (any Error)?) -> Void
  ) -> Progress? {
    switch typeIdentifier {
    case UTType.plainText.identifier:
      completionHandler(formatter.plainText().data(using: .utf8), nil)
    case UTType.html.identifier:
      completionHandler(formatter.html().data(using: .utf8), nil)
    default:
      completionHandler(nil, nil)
    }
    return nil
  }
}
