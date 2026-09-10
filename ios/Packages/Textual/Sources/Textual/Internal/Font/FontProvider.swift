import SwiftUI

protocol FontProvider: Sendable, Hashable {
  // NB: This multiplicative factor supports arbitrary font scaling on platforms
  //     without `Font.scaled(by:)`. Where available, we reflect `Font.scaled(by:)`
  //     as a `FontModifier`. Providers must include that reflected scale in
  //     `size(in:)` so measurements match rendering.
  var scale: CGFloat { get set }

  func size(in environment: TextEnvironmentValues) -> CGFloat

  func resolve(in environment: TextEnvironmentValues) -> Font
}
