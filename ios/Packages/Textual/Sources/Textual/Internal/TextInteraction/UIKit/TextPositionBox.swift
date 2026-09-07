#if TEXTUAL_ENABLE_TEXT_SELECTION && canImport(UIKit)
  import UIKit

  final class TextPositionBox: UITextPosition {
    let wrappedValue: TextPosition

    override var description: String {
      wrappedValue.description
    }

    init(_ wrappedValue: TextPosition) {
      self.wrappedValue = wrappedValue
    }
  }
#endif
