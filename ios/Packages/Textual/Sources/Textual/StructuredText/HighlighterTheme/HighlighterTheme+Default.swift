import SwiftUI

extension StructuredText.HighlighterTheme {
  /// The default syntax-highlighting theme used by Textual.
  public static let `default` = Self(
    foregroundColor: .codePlain,
    backgroundColor: .codeBackground,
    tokenProperties: [
      // Keywords
      .keyword: AnyTextProperty(
        .foregroundColor(.codeKeyword),
        .fontWeight(.semibold)
      ),
      .builtin: AnyTextProperty(.foregroundColor(.codeBuiltin)),
      .literal: AnyTextProperty(
        .foregroundColor(.codeKeyword),
        .fontWeight(.semibold)
      ),
      // Strings and characters
      .string: AnyTextProperty(.foregroundColor(.codeString)),
      .char: AnyTextProperty(.foregroundColor(.codeChar)),
      .regex: AnyTextProperty(.foregroundColor(.codeString)),
      .url: AnyTextProperty(.foregroundColor(.codeURL)),
      // Numbers and symbols
      .number: AnyTextProperty(.foregroundColor(.codeNumber)),
      .symbol: AnyTextProperty(.foregroundColor(.codePlain)),
      .boolean: AnyTextProperty(
        .foregroundColor(.codeKeyword),
        .fontWeight(.semibold)
      ),
      // Types and classes
      .className: AnyTextProperty(.foregroundColor(.codeClass)),
      // Functions
      .function: AnyTextProperty(.foregroundColor(.codeFunction)),
      .functionName: AnyTextProperty(.foregroundColor(.codeFunction)),
      // Variables and properties
      .variable: AnyTextProperty(.foregroundColor(.codeVariable)),
      .constant: AnyTextProperty(.foregroundColor(.codeConstant)),
      .property: AnyTextProperty(.foregroundColor(.codeVariable)),
      // Comments
      .comment: AnyTextProperty(.foregroundColor(.codeComment)),
      .blockComment: AnyTextProperty(.foregroundColor(.codeComment)),
      .docComment: AnyTextProperty(.foregroundColor(.codeComment)),
      .mark: AnyTextProperty(
        .foregroundColor(.codeMark),
        .fontWeight(.bold)
      ),
      // Preprocessor
      .preprocessor: AnyTextProperty(.foregroundColor(.codePreprocessor)),
      // Swift
      .directive: AnyTextProperty(.foregroundColor(.codePreprocessor)),
      .attribute: AnyTextProperty(.foregroundColor(.codeAttribute)),
      // Markup
      .tag: AnyTextProperty(.foregroundColor(.codeChar)),
      .attributeName: AnyTextProperty(.foregroundColor(.codeAttribute)),
      // Diff
      .inserted: AnyTextProperty(.foregroundColor(.codeInserted)),
      .deleted: AnyTextProperty(.foregroundColor(.codeDeleted)),
    ]
  )
}

extension DynamicColor {
  fileprivate static let codeKeyword = DynamicColor(
    light: Color(red: 0.607592, green: 0.137526, blue: 0.576284),
    dark: Color(red: 0.988394, green: 0.37355, blue: 0.638329)
  )

  fileprivate static let codeBuiltin = DynamicColor(
    light: Color(red: 0.224543, green: 0, blue: 0.628029),
    dark: Color(red: 0.632318, green: 0.402193, blue: 0.901151)
  )

  fileprivate static let codeString = DynamicColor(
    light: Color(red: 0.77, green: 0.102, blue: 0.086),
    dark: Color(red: 0.989117, green: 0.41558, blue: 0.365684)
  )

  fileprivate static let codeChar = DynamicColor(
    light: Color(red: 0.11, green: 0, blue: 0.81),
    dark: Color(red: 0.815686, green: 0.74902, blue: 0.411765)
  )

  fileprivate static let codeURL = DynamicColor(
    light: Color(red: 0.055, green: 0.055, blue: 1),
    dark: Color(red: 0.330191, green: 0.511266, blue: 0.998589)
  )

  fileprivate static let codeNumber = DynamicColor(
    light: Color(red: 0.11, green: 0, blue: 0.81),
    dark: Color(red: 0.814983, green: 0.749393, blue: 0.412334)
  )

  fileprivate static let codeClass = DynamicColor(
    light: Color(red: 0.109812, green: 0.272761, blue: 0.288691),
    dark: Color(red: 0.619608, green: 0.945098, blue: 0.866667)
  )

  fileprivate static let codeFunction = DynamicColor(
    light: Color(red: 0.194184, green: 0.429349, blue: 0.454553),
    dark: Color(red: 0.403922, green: 0.717647, blue: 0.643137)
  )

  fileprivate static let codeVariable = DynamicColor(
    light: Color(red: 0.194184, green: 0.429349, blue: 0.454553),
    dark: Color(red: 0.405383, green: 0.717051, blue: 0.642088)
  )

  fileprivate static let codeConstant = DynamicColor(
    light: Color(red: 0.194184, green: 0.429349, blue: 0.454553),
    dark: Color(red: 0.405383, green: 0.717051, blue: 0.642088)
  )

  fileprivate static let codeComment = DynamicColor(
    light: Color(red: 0.36526, green: 0.421879, blue: 0.475154),
    dark: Color(red: 0.423943, green: 0.474618, blue: 0.525183)
  )

  fileprivate static let codeMark = DynamicColor(
    light: Color(red: 0.290196, green: 0.333333, blue: 0.376471),
    dark: Color(red: 0.572549, green: 0.631373, blue: 0.694118)
  )

  fileprivate static let codePreprocessor = DynamicColor(
    light: Color(red: 0.391471, green: 0.220311, blue: 0.124457),
    dark: Color(red: 0.991311, green: 0.560764, blue: 0.246107)
  )

  fileprivate static let codeAttribute = DynamicColor(
    light: Color(red: 0.505801, green: 0.371396, blue: 0.012096),
    dark: Color(red: 0.74902, green: 0.521569, blue: 0.333333)
  )

  fileprivate static let codeInserted = DynamicColor(
    light: Color(red: 0.203922, green: 0.780392, blue: 0.349020),
    dark: Color(red: 0.188235, green: 0.819608, blue: 0.345098)
  )

  fileprivate static let codeDeleted = DynamicColor(
    light: Color(red: 1, green: 0.219608, blue: 0.235294),
    dark: Color(red: 1, green: 0.258824, blue: 0.270588)
  )
}
