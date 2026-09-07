import SwiftUI

extension DynamicColor {
  static let grid = DynamicColor(
    light: Color(red: 210 / 255, green: 210 / 255, blue: 215 / 255),
    dark: Color(red: 66 / 255, green: 66 / 255, blue: 69 / 255)
  )

  static let asideBackground = DynamicColor(
    light: Color(red: 245 / 255, green: 245 / 255, blue: 245 / 255),
    dark: Color(red: 34 / 255, green: 34 / 255, blue: 34 / 255)
  )

  static let asideBorder: DynamicColor = .init(
    light: Color(red: 102 / 255, green: 102 / 255, blue: 102 / 255),
    dark: Color(red: 176 / 255, green: 176 / 255, blue: 176 / 255)
  )

  static let link: DynamicColor = .init(
    light: Color(red: 51 / 255, green: 102 / 255, blue: 255 / 255),
    dark: Color(red: 0 / 255, green: 153 / 255, blue: 255 / 255)
  )

  static let grayTertiary: DynamicColor = .init(
    light: Color(red: 240 / 255, green: 240 / 255, blue: 240 / 255),
    dark: Color(red: 66 / 255, green: 66 / 255, blue: 66 / 255)
  )
}
