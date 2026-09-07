import Foundation

extension Array where Element: AnyObject {
  func removingIdenticalDuplicates() -> Self {
    var identifiers: Set<ObjectIdentifier> = []
    var result: Self = []

    result.reserveCapacity(underestimatedCount)

    for element in self {
      if identifiers.insert(.init(element)).inserted {
        result.append(element)
      }
    }

    return result
  }
}

extension Array where Element == NSAttributedString {
  // Joins attributed strings and tracks the character offset where each original string begins
  // in the joined result. The offsets map allows converting ranges in the original strings to
  // ranges in the joined string.
  func joined() -> (joined: NSAttributedString, characterOffsets: [ObjectIdentifier: Int]) {
    guard !isEmpty else {
      let attributedString = NSAttributedString()
      return (attributedString, [ObjectIdentifier(attributedString): 0])
    }

    guard count > 1 else {
      return (self[0], [ObjectIdentifier(self[0]): 0])
    }

    let joined = NSMutableAttributedString()

    var characterOffsets: [ObjectIdentifier: Int] = [:]
    characterOffsets.reserveCapacity(underestimatedCount)

    var offset = 0

    for element in self {
      joined.append(element)

      characterOffsets[ObjectIdentifier(element)] = offset
      offset += element.length
    }

    return (joined, characterOffsets)
  }
}
