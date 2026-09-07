import Foundation

struct TupleTextProperty<each P: TextProperty>: TextProperty {
  var properties: (repeat each P)

  init(_ properties: repeat each P) {
    self.properties = (repeat each properties)
  }

  func apply(in attributes: inout AttributeContainer, environment: TextEnvironmentValues) {
    for property in repeat (each properties) {
      property.apply(in: &attributes, environment: environment)
    }
  }

  static func == (lhs: Self, rhs: Self) -> Bool {
    for (left, right) in repeat (each lhs.properties, each rhs.properties) {
      guard left == right else { return false }
    }
    return true
  }

  func hash(into hasher: inout Hasher) {
    for property in repeat (each properties) {
      hasher.combine(property)
    }
  }
}
