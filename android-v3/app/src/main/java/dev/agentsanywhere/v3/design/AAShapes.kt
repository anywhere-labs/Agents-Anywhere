package dev.agentsanywhere.v3.design

import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Dp
import com.kyant.shapes.RoundedCornerStyle
import com.kyant.shapes.RoundedRectangle
import com.kyant.shapes.UnevenRoundedRectangle

/**
 * SwiftUI's `RoundedRectangle(cornerRadius:style: .continuous)`: corners with continuous curvature (G2, a squircle-like
 * blend into the straight edges), not a circular arc. Every non-capsule rounded rectangle in the app uses this.
 */
fun continuousRect(radius: Dp): Shape = RoundedRectangle(radius, RoundedCornerStyle.Continuous)

/** Per-corner radii (the drawer card follows the display's own corners, which may differ per corner). */
fun continuousRect(topStart: Dp, topEnd: Dp, bottomEnd: Dp, bottomStart: Dp): Shape =
    UnevenRoundedRectangle(topStart, topEnd, bottomEnd, bottomStart, RoundedCornerStyle.Continuous)
