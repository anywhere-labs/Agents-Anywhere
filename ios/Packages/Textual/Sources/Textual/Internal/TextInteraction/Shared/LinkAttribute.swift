import SwiftUI

struct LinkAttribute: TextAttribute {
  var url: URL

  init(_ url: URL) {
    self.url = url
  }
}

extension Text.Layout.Run {
  var url: URL? {
    self[LinkAttribute.self]?.url
  }
}
