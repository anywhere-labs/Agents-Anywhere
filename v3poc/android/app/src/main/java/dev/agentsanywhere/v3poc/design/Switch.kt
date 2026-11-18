package dev.agentsanywhere.v3poc.design

import android.os.Build
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import com.kyant.backdrop.backdrops.layerBackdrop
import com.kyant.backdrop.backdrops.rememberLayerBackdrop
import com.kyant.backdrop.drawBackdrop
import com.kyant.backdrop.effects.lens
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.roundToInt

private val TrackWidth = 63.dp
private val TrackHeight = 28.dp
private val ThumbWidth = 37.dp
private val ThumbHeight = 24.dp
private val ThumbInset = 2.dp
/** While held, the thumb grows uniformly to this scale and turns into a clear glass lens over the track. */
private const val HeldScale = 1.5f
private val ThumbSpring = spring<Float>(dampingRatio = 0.68f, stiffness = 520f)

/**
 * The iOS 26 switch: a 63×28 track with a capsule thumb (37×24). Touching it grows the thumb into a clear glass lens
 * (uniform scale, damped like the other liquid controls) that refracts the track under it; it can be dragged, and the
 * track colour follows the thumb's position. Releasing shrinks it back to a white capsule. Tap toggles; a drag decides
 * by where the thumb is let go; a vertical drag is left to the scrolling parent.
 * Android 13+ draws the lens (RuntimeShader); below that the held thumb is a translucent white capsule.
 */
@Composable
fun AASwitch(checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    val c = AA.colors
    val dark = LocalDark.current
    val scope = rememberCoroutineScope()
    val position = remember { Animatable(if (checked) 1f else 0f) }
    val held = remember { Animatable(0f) }
    var dragging by remember { mutableStateOf(false) }
    val currentChecked by rememberUpdatedState(checked)
    val currentOnChange by rememberUpdatedState(onChange)
    LaunchedEffect(checked) { if (!dragging) position.animateTo(if (checked) 1f else 0f, ThumbSpring) }
    val offTrack = c.fillTertiary.copy(alpha = 0.32f)
    val onTrack = c.green
    val lensed = Build.VERSION.SDK_INT >= 33
    val trackBackdrop = rememberLayerBackdrop()

    Box(
        Modifier
            .size(TrackWidth, TrackHeight)
            .graphicsLayer { alpha = if (enabled) 1f else 0.5f }
            .semantics {
                role = Role.Switch
                toggleableState = ToggleableState(checked)
                if (enabled) onClick { onChange(!checked); true } else disabled()
            }
            .pointerInput(enabled) {
                if (!enabled) return@pointerInput
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val start = position.value
                    val travel = (TrackWidth - ThumbWidth - ThumbInset * 2).toPx()
                    val slop = viewConfiguration.touchSlop
                    scope.launch { held.animateTo(1f, AAMotion.liquidPress) }
                    var total = Offset.Zero
                    var moved = false
                    var yielded = false
                    while (true) {
                        val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: break
                        if (!change.pressed) break
                        total += change.positionChange()
                        if (!moved) {
                            if (abs(total.y) > slop && abs(total.y) > abs(total.x)) { yielded = true; break }
                            if (abs(total.x) > slop) { moved = true; dragging = true }
                        }
                        if (moved) {
                            change.consume()
                            val next = (start + total.x / travel).coerceIn(0f, 1f)
                            scope.launch { position.snapTo(next) }
                        }
                    }
                    scope.launch { held.animateTo(0f, AAMotion.liquidPress) }
                    dragging = false
                    if (yielded) return@awaitEachGesture
                    val target = if (moved) position.value > 0.5f else !currentChecked
                    scope.launch { position.animateTo(if (target) 1f else 0f, ThumbSpring) }
                    if (target != currentChecked) currentOnChange(target)
                }
            },
    ) {
        // Track: its colour follows the thumb. Recorded so the held thumb can refract it.
        Box(
            Modifier
                .size(TrackWidth, TrackHeight)
                .then(if (lensed) Modifier.layerBackdrop(trackBackdrop) else Modifier)
                .drawBehind {
                    drawRoundRect(lerp(offTrack, onTrack, position.value), cornerRadius = CornerRadius(size.height / 2))
                },
        )
        // Thumb: placed by its centre so it grows evenly around it (and past the track) while held.
        val thumbShape = RoundedCornerShape(50)
        val thumb = Modifier.layout { measurable, _ ->
            val scale = 1f + (HeldScale - 1f) * held.value
            val w = (ThumbWidth.toPx() * scale).roundToInt()
            val h = (ThumbHeight.toPx() * scale).roundToInt()
            val placeable = measurable.measure(Constraints.fixed(w, h))
            val travel = (TrackWidth - ThumbWidth - ThumbInset * 2).toPx()
            val cx = ThumbInset.toPx() + ThumbWidth.toPx() / 2 + travel * position.value
            val cy = TrackHeight.toPx() / 2
            layout(TrackWidth.roundToPx(), TrackHeight.roundToPx()) {
                placeable.place((cx - w / 2f).roundToInt(), (cy - h / 2f).roundToInt())
            }
        }
        if (lensed) {
            Box(
                thumb.drawBackdrop(
                    backdrop = trackBackdrop,
                    shape = { thumbShape },
                    effects = {
                        val p = held.value
                        if (p > 0.02f) lens(10.dp.toPx() * p, 16.dp.toPx() * p, chromaticAberration = true)
                    },
                    highlight = { edgeHighlight(dark) },
                    shadow = { com.kyant.backdrop.shadow.Shadow(radius = 6.dp, offset = DpOffset(0.dp, 2.dp), color = Color.Black.copy(alpha = 0.14f)) },
                    // White at rest; nearly clear while held, so the lens shows the track through it.
                    onDrawSurface = { drawRect(Color.White.copy(alpha = 1f - 0.9f * held.value)) },
                ),
            )
        } else {
            Box(
                thumb.shadow(3.dp, thumbShape).drawBehind {
                    drawRoundRect(Color.White.copy(alpha = 1f - 0.4f * held.value), cornerRadius = CornerRadius(size.height / 2))
                },
            )
        }
    }
}
