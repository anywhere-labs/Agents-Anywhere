package dev.agentsanywhere.v3poc.ui

import dev.agentsanywhere.v3poc.design.continuousRect
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.systemGestureExclusion
import androidx.compose.ui.Alignment
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.addOutline
import androidx.compose.ui.graphics.asAndroidPath
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import dev.agentsanywhere.v3poc.design.AA
import dev.agentsanywhere.v3poc.design.AAMetrics
import dev.agentsanywhere.v3poc.design.AAMotion
import dev.agentsanywhere.v3poc.design.iosSpring
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * The iOS PoC's `SidebarDrawer`: the sidebar sits under the page; opening slides the whole page card to the right by
 * 75 % of the width, rounds its corners and shades it, and leaves a strip of it that closes the drawer when tapped.
 * Opens from the left edge (a 44 × 200 dp band, the most the system lets us take from its back gesture) or the menu
 * button; closes by dragging left on the sidebar or the strip, tapping the strip, or Back. No gesture sits on the page
 * card or above it while closed, so the WebView gets its touches (tables, code blocks, selection) untouched.
 */
@Composable
fun SidebarDrawer(open: Boolean, onOpenChange: (Boolean) -> Unit, sidebar: @Composable () -> Unit, content: @Composable () -> Unit) {
    val progress = remember { Animatable(if (open) 1f else 0f) }
    var dragging by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    val spring = iosSpring<Float>(AAMotion.drawerSpring.response, AAMotion.drawerSpring.dampingRatio, 0.0005f)
    LaunchedEffect(open) {
        if (!dragging) progress.animateTo(if (open) 1f else 0f, spring)
    }
    BackHandler(enabled = open) { onOpenChange(false) }

    BoxWithConstraints(Modifier.fillMaxSize().background(AA.colors.background)) {
        val density = LocalDensity.current
        val revealPx = with(density) { maxWidth.toPx() } * AAMetrics.sidebarRevealFraction
        val slop = LocalViewConfiguration.current.touchSlop
        val revealDp = maxWidth * AAMetrics.sidebarRevealFraction
        val screenCorners = rememberScreenCornerShape()
        val p = progress.value

        fun settle(velocityX: Float, cancelled: Boolean) {
            val projected = progress.value + velocityX * AAMotion.drawerSpring.projectionSeconds / revealPx
            val target = if ((if (cancelled) progress.value else projected) >= AAMotion.drawerSpring.threshold) 1f else 0f
            val remaining = target - progress.value
            val initial = if (abs(remaining) > 0.001f) (velocityX / revealPx) else 0f
            if ((target == 1f) != open) haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
            onOpenChange(target == 1f)
            scope.launch {
                progress.animateTo(target, spring, initial)
                dragging = false
            }
        }

        // A horizontal pull (opening: rightward, closing: leftward), on the drawer's own regions only: the left-edge
        // band while closed, the sidebar and the visible strip of the card while open. Never on an ancestor of the
        // WebView: every touch on the thread belongs to the WebView alone.
        fun drag(opening: Boolean) = Modifier.pointerInput(opening, revealPx) {
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false)
                var horizontal = false
                var dx = 0f
                var dy = 0f
                val tracker = VelocityTracker()
                tracker.addPosition(down.uptimeMillis, down.position)
                while (true) {
                    val event = awaitPointerEvent()
                    val change = event.changes.firstOrNull { it.id == down.id } ?: break
                    tracker.addPosition(change.uptimeMillis, change.position)
                    val delta = change.positionChange()
                    if (!change.pressed) break
                    if (!horizontal) {
                        dx += delta.x; dy += delta.y
                        if (abs(dx) > slop && abs(dx) > abs(dy)) {
                            if (if (opening) dx <= 0 else dx >= 0) return@awaitEachGesture
                            horizontal = true
                            dragging = true
                            scope.launch { progress.stop() }
                        } else if (abs(dy) > slop) return@awaitEachGesture
                    }
                    if (horizontal) {
                        change.consume()
                        val next = (progress.value + delta.x / revealPx).coerceIn(0f, 1f)
                        scope.launch { progress.snapTo(next) }
                    }
                }
                if (horizontal) settle(tracker.calculateVelocity().x, cancelled = false)
            }
        }

        Box(Modifier.fillMaxSize()) {
            // Sidebar: scales up from 0.95 and loses its shade as the card moves away.
            Box(
                Modifier.width(revealDp).fillMaxHeight()
                    .graphicsLayer {
                        val s = AAMetrics.sidebarClosedScale + (1 - AAMetrics.sidebarClosedScale) * p
                        scaleX = s; scaleY = s
                        transformOrigin = TransformOrigin(0f, 0.5f)
                    }
                    .background(AA.colors.background)
                    .then(if (open) drag(opening = false) else Modifier),
            ) {
                sidebar()
                Box(Modifier.fillMaxSize().graphicsLayer { alpha = AAMetrics.sidebarOverlayOpacity * (1 - p) }.background(AA.colors.background))
            }

            // The page card.
            val cardShape = if (p > 0.0005f) screenCorners else RectangleShape
            // Its shadow, as iOS draws it (CALayer: black 0.28, radius 18 pt, offset −3 pt, on every side; measured on
            // the light sidebar: 16 % at the card edge fading out over ~40 pt). Android's elevation shadow is lit from
            // above and hardly shows on the card's left edge, so it is drawn here: a Gaussian shadow layer (sigma ≈ 18 dp)
            // under the card. Invisible over the black dark-mode sidebar, as on iOS.
            if (p > 0.0005f) {
                val shadowFill = AA.colors.background
                Box(
                    Modifier.fillMaxSize()
                        .offset { IntOffset((revealPx * p).roundToInt(), 0) }
                        .drawBehind {
                            val sigma = 18.dp.toPx()
                            val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
                                color = shadowFill.toArgb()
                                // Skia: sigma = radius * 0.57735 + 0.5.
                                setShadowLayer(((sigma - 0.5f) / 0.57735f).coerceAtLeast(1f), -3.dp.toPx(), 0f,
                                    androidx.compose.ui.graphics.Color.Black.copy(alpha = 0.28f * p).toArgb())
                            }
                            val path = androidx.compose.ui.graphics.Path().apply { addOutline(cardShape.createOutline(size, layoutDirection, this@drawBehind)) }
                            drawIntoCanvas { it.nativeCanvas.drawPath(path.asAndroidPath(), paint) }
                        },
                )
            }
            Box(
                Modifier.fillMaxSize()
                    .offset { IntOffset((revealPx * p).roundToInt(), 0) }
                    .graphicsLayer {
                        shape = cardShape
                        clip = p > 0.0005f
                    }
                    .background(AA.colors.background),
            ) {
                content()
                if (p > 0.0005f) {
                    Box(Modifier.fillMaxSize().graphicsLayer { alpha = p }.background(AA.colors.drawerContentOverlay)
                        .border(1.dp, AA.colors.drawerCardStroke, cardShape))
                }
            }
            // Android's back gesture owns the screen edges. Like iOS, the drawer opens from the left edge: a 200 dp band
            // (the most the system allows per edge) is excluded from the back gesture while the drawer is closed.
            // This band is also where the drawer is pulled open (it stays while that drag runs).
            if ((!open && p < 0.001f) || (dragging && !open)) {
                Box(Modifier.align(Alignment.CenterStart).offset(y = 80.dp).width(AAMetrics.sidebarEdgeActivationWidth).height(200.dp)
                    .systemGestureExclusion().then(drag(opening = true)))
            }
            // The visible strip of the card closes the drawer: tap, or pull left.
            if (open || p > 0.0005f) {
                Box(
                    Modifier.fillMaxSize().offset { IntOffset((revealPx * p).roundToInt(), 0) }
                        .then(drag(opening = false))
                        .clickable(remember { MutableInteractionSource() }, null, onClickLabel = "关闭侧栏") { onOpenChange(false) },
                )
            }
        }
    }
}


/**
 * The card's corners follow the display's own (`WindowInsets.getRoundedCorner`, Android 12+, per corner), with
 * continuous curvature like iOS's `.continuous`; 44 dp where the system reports none.
 */
@Composable
private fun rememberScreenCornerShape(): androidx.compose.ui.graphics.Shape {
    val view = androidx.compose.ui.platform.LocalView.current
    val density = LocalDensity.current
    return remember(view, density) {
        val fallback = AAMetrics.sidebarCardCornerRadius
        val insets = view.rootWindowInsets
        fun corner(position: Int): androidx.compose.ui.unit.Dp {
            if (android.os.Build.VERSION.SDK_INT < 31 || insets == null) return fallback
            val r = insets.getRoundedCorner(position)?.radius ?: return fallback
            return if (r <= 0) fallback else with(density) { r.toDp() }
        }
        if (android.os.Build.VERSION.SDK_INT >= 31) {
            continuousRect(
                corner(android.view.RoundedCorner.POSITION_TOP_LEFT), corner(android.view.RoundedCorner.POSITION_TOP_RIGHT),
                corner(android.view.RoundedCorner.POSITION_BOTTOM_RIGHT), corner(android.view.RoundedCorner.POSITION_BOTTOM_LEFT),
            )
        } else continuousRect(fallback)
    }
}
