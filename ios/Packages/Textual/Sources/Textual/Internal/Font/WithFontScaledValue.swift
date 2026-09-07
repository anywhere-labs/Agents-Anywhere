import SwiftUI

struct WithFontScaledValue<Value, Content>: View where Value: FontScalable, Content: View {
  @Environment(\.textEnvironment) private var environment

  private let value: FontScaled<Value>
  private let content: (Value) -> Content

  init(_ value: FontScaled<Value>, @ViewBuilder content: @escaping (Value) -> Content) {
    self.value = value
    self.content = content
  }

  var body: some View {
    content(value.resolve(in: environment))
  }
}
