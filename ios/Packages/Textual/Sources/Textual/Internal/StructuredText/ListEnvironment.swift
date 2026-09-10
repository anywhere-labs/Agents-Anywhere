import SwiftUI

extension EnvironmentValues {
  @Entry var listItemSpacing: FontScaled<StructuredText.BlockSpacing> = .fontScaled(top: 0.25)
  @Entry var resolvedListItemSpacing: StructuredText.BlockSpacing = .init()
  @Entry var listItemSpacingEnabled: Bool = false
}
