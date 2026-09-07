import Foundation

struct Tuple<each V: Equatable>: Equatable {
  var values: (repeat each V)

  init(_ values: repeat each V) {
    self.values = (repeat each values)
  }

  static func == (lhs: Self, rhs: Self) -> Bool {
    for (left, right) in repeat (each lhs.values, each rhs.values) {
      guard left == right else { return false }
    }
    return true
  }
}
