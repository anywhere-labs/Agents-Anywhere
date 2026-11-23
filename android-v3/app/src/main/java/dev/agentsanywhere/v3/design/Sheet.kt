package dev.agentsanywhere.v3.design

import androidx.compose.foundation.layout.heightIn

import androidx.compose.foundation.layout.Spacer

import androidx.compose.foundation.layout.Row

import androidx.compose.runtime.CompositionLocalProvider

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.util.lerp
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.roundToInt

/** SwiftUI `Spring(response:dampingRatio:)` as a Compose spring (mass 1). */
fun <T> iosSpring(response: Float, dampingRatio: Float = 1f, visibilityThreshold: T? = null) =
    spring(dampingRatio = dampingRatio, stiffness = (2 * Math.PI / response).let { (it * it).toFloat() }, visibilityThreshold = visibilityThreshold)

/**
 * An iOS 26 style sheet: a floating card at the medium detent (inset from the screen edges, 36 dp continuous
 * corners, **glass**), growing to the large detent where it meets the screen edges and becomes **opaque**; the change is
 * continuous with the drag. Grabber, drag down to dismiss (also from scrolled-to-top content), drag up to large, Back
 * closes it. Drawn in-tree above the page, so its glass samples the thread; glass inside it samples the sheet (OnGlass).
 */
@Composable
fun AASheet(
    visible: Boolean,
    onDismiss: () -> Unit,
    allowsLarge: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    var shown by remember { mutableStateOf(false) }
    if (visible) shown = true
    if (!shown) return
    RegisterOverlay()
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val density = LocalDensity.current
        val screenH = with(density) { maxHeight.toPx() }
        val statusTop = WindowInsets.statusBars.getTop(density).toFloat()
        val medium = screenH * AAMetrics.sheetMediumFraction
        val large = screenH - statusTop - with(density) { AAMetrics.sheetLargeTopInset.toPx() }
        val height = remember { Animatable(0f) }
        val scope = rememberCoroutineScope()
        val spec = iosSpring<Float>(AAMotion.sheetSpring.response, AAMotion.sheetSpring.dampingRatio, 0.5f)
        LaunchedEffect(visible) {
            if (visible) height.animateTo(medium, spec) else { height.animateTo(0f, spec); shown = false }
        }
        fun settle(velocity: Float) {
            val projected = height.value - velocity * 0.2f
            val stops = if (allowsLarge) listOf(0f, medium, large) else listOf(0f, medium)
            val target = stops.minBy { abs(it - projected) }
            scope.launch {
                if (target == 0f) { onDismiss() } else height.animateTo(target, spec, -velocity)
            }
        }
        val drag = rememberDraggableState { delta -> scope.launch { height.snapTo((height.value - delta).coerceIn(0f, if (allowsLarge) large else medium * 1.04f)) } }
        val nested = remember(medium, large) {
            object : NestedScrollConnection {
                override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                    // Pull up: grow to large before the content scrolls.
                    if (available.y < 0 && allowsLarge && height.value < large - 0.5f) {
                        val next = (height.value - available.y).coerceAtMost(large)
                        val used = next - height.value
                        scope.launch { height.snapTo(next) }
                        return Offset(0f, -used)
                    }
                    return Offset.Zero
                }
                override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                    // Content at its top and still pulling down: the sheet follows.
                    if (available.y > 0 && source == NestedScrollSource.UserInput) {
                        scope.launch { height.snapTo((height.value - available.y).coerceAtLeast(0f)) }
                        return Offset(0f, available.y)
                    }
                    return Offset.Zero
                }
                override suspend fun onPreFling(available: Velocity): Velocity {
                    val h = height.value
                    if (h != medium && h != large && h > 0f) { settle(available.y); return available }
                    return Velocity.Zero
                }
            }
        }
        BackHandler(enabled = visible) { onDismiss() }
        val progress = (height.value / medium).coerceIn(0f, 1f)
        val toLarge = if (large > medium) ((height.value - medium) / (large - medium)).coerceIn(0f, 1f) else 0f
        // Scrim: like iOS, the page is not dimmed at the medium detent (the glass sheet floats over it); the dimming
        // grows only towards large. Tapping outside dismisses either way.
        Box(Modifier.fillMaxSize().graphicsLayer { alpha = toLarge }.background(AA.colors.sheetScrim)
            .clickable(remember { MutableInteractionSource() }, null) { onDismiss() })
        val inset: Dp = AAMetrics.sheetOuterInset * (1f - toLarge)
        val panelH = maxOf(height.value, medium)
        val panelHDp = with(density) { panelH.toDp() }
        val shape = continuousRect(AAMetrics.sheetCornerRadius)
        val sheetBackdrop = com.kyant.backdrop.backdrops.rememberLayerBackdrop()
        val panelWidthPx = with(density) { maxWidth.toPx() }
        val c = AA.colors
        Column(
            Modifier
                .align(Alignment.BottomCenter)
                .offset { IntOffset(0, (maxOf(0f, medium - height.value)).roundToInt()) }
                .padding(start = inset, end = inset, bottom = inset)
                .fillMaxWidth()
                .height(panelHDp - inset)
                // The blur follows the part of the sheet on screen: it grows as the sheet is pulled up, and shrinks
                // as it slides away below the medium detent (there the panel keeps its size and moves down).
                .glass(shape, GlassKind.Sheet, exportTo = sheetBackdrop, blurSize = {
                    val insetPx = with(density) { inset.toPx() }
                    androidx.compose.ui.geometry.Size(panelWidthPx - 2 * insetPx, (height.value - insetPx).coerceAtLeast(0f))
                })
                // Medium: glass. Towards large: an opaque surface fades in over it (fully opaque at large).
                .background(c.sheetBackgroundOpaque.copy(alpha = toLarge), shape)
                // Everything inside stays within the card (pages moving in from the side, scrolled rows).
                .clip(shape)
                .nestedScroll(nested),
        ) {
            // Grabber + header area drag the sheet itself.
            Box(
                Modifier.fillMaxWidth().height(AAMetrics.sheetGrabberTop + AAMetrics.sheetGrabberHeight + 4.dp)
                    .draggable(drag, Orientation.Vertical, onDragStopped = { settle(it) }),
                contentAlignment = Alignment.TopCenter,
            ) {
                Box(Modifier.padding(top = AAMetrics.sheetGrabberTop).width(AAMetrics.sheetGrabberWidth).height(AAMetrics.sheetGrabberHeight)
                    .background(AA.colors.tertiaryLabel, RoundedCornerShape(50)))
            }
            Column(Modifier.fillMaxWidth().weight(1f).draggable(drag, Orientation.Vertical, onDragStopped = { settle(it) })) {
                OnGlass(sheetBackdrop) { Column { content() } }
            }
        }
    }
}

/** The sheet's navigation bar (iOS): leading close (X) or back (‹) glass circle, centered headline title. */
@Composable
fun SheetHeader(title: String, back: Boolean = false, onLeading: () -> Unit) {
    // The grabber strip above is 15 dp; the button sits 14 dp below the sheet's top edge, as on iOS.
    Box(Modifier.fillMaxWidth().height(AAMetrics.sheetHeaderHeight - 15.dp)) {
        GlassCircleButton(if (back) "ChevronLeft" else "xmark", if (back) "返回" else "关闭", iconSize = 20.dp,
            modifier = Modifier.align(Alignment.TopStart).offset(x = AAMetrics.sheetHeaderButtonInset), onClick = onLeading)
        Box(Modifier.align(Alignment.TopCenter).height(AAMetrics.toolbarButtonDiameter).padding(horizontal = 72.dp), contentAlignment = Alignment.Center) {
            AAText(title, font = AAFonts.headline, maxLines = 1)
        }
    }
}

@Suppress("unused")
private val unusedSize = Modifier.size(0.dp)

@Suppress("unused")
private fun lerpDp(a: Dp, b: Dp, t: Float) = Dp(lerp(a.value, b.value, t))
