import Foundation

extension Range where Bound == Int {
  func offset(by amount: Int) -> Range<Int> {
    (lowerBound + amount)..<(upperBound + amount)
  }
}
