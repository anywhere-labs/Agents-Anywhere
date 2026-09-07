import SwiftUI

extension StructuredText {
  /// The default table cell style used by ``StructuredText/DefaultStyle``.
  public struct DefaultTableCellStyle: TableCellStyle {
    /// Creates the default table cell style.
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
      configuration.label
        .fontWeight(configuration.row == 0 ? .semibold : .regular)
        .textual.lineSpacing(.fontScaled(0.471))
        .textual.padding(.fontScaled(0.588))
    }
  }
}

extension StructuredText.TableCellStyle where Self == StructuredText.DefaultTableCellStyle {
  /// The default table cell style.
  public static var `default`: Self {
    .init()
  }
}
