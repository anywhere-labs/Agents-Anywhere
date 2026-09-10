#if TEXTUAL_ENABLE_TEXT_SELECTION && canImport(UIKit)
  import UIKit
  import LinkPresentation

  final class TextActivityItemSource: NSObject, UIActivityItemSource {
    let transferableText: TransferableText

    init(attributedString: NSAttributedString) {
      self.transferableText = TransferableText(attributedString: attributedString)
      super.init()
    }

    func activityViewControllerPlaceholderItem(
      _ activityViewController: UIActivityViewController
    ) -> Any {
      transferableText.attributedString.string
    }

    func activityViewController(
      _ activityViewController: UIActivityViewController,
      itemForActivityType activityType: UIActivity.ActivityType?
    ) -> Any? {
      NSItemProvider(object: transferableText)
    }

    func activityViewControllerLinkMetadata(_ activityViewController: UIActivityViewController)
      -> LPLinkMetadata?
    {
      let metadata = LPLinkMetadata()
      metadata.title = transferableText.attributedString.string

      if let icon = UIImage(systemName: "character.cursor.ibeam")?
        .applyingSymbolConfiguration(.init(hierarchicalColor: .label))?
        .withRenderingMode(.alwaysOriginal)
      {
        metadata.iconProvider = NSItemProvider(object: icon)
      }

      return metadata
    }
  }
#endif
