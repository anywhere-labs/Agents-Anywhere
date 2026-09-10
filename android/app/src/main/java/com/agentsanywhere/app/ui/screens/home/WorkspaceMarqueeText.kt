package com.agentsanywhere.app.ui.screens.home

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

/** Matches Web's 350 ms pause and 30 ms per logical pixel, stopping at the end. */
@Composable
internal fun WorkspaceMarqueeText(text: String, selected: Boolean, style: TextStyle) {
    val density = LocalDensity.current
    val measurer = rememberTextMeasurer()
    val pathStyle = style.copy(textDirection = TextDirection.Ltr)
    val textWidth = remember(text, pathStyle, measurer, density) {
        measurer.measure(text, style = pathStyle, softWrap = false, maxLines = 1).size.width
    }
    var viewportWidth by remember { mutableIntStateOf(0) }
    val distance = (textWidth - viewportWidth).coerceAtLeast(0).toFloat()
    val offset = remember { Animatable(0f) }

    LaunchedEffect(text, selected, distance, density) {
        offset.snapTo(0f)
        if (!selected || viewportWidth == 0 || distance == 0f) return@LaunchedEffect
        if (coroutineContext[MotionDurationScale]?.scaleFactor == 0f) return@LaunchedEffect
        delay(350)
        offset.animateTo(
            targetValue = distance,
            animationSpec = tween(
                durationMillis = (distance / density.density * 30f).roundToInt().coerceAtLeast(1),
                easing = LinearEasing,
            ),
        )
    }

    Box(Modifier.fillMaxWidth().clipToBounds().onSizeChanged { viewportWidth = it.width }) {
        Text(
            text = text,
            style = pathStyle,
            maxLines = 1,
            softWrap = false,
            overflow = if (selected && distance > 0f) TextOverflow.Clip else TextOverflow.Ellipsis,
            modifier = if (selected && distance > 0f) {
                Modifier.wrapContentWidth(Alignment.Start, unbounded = true)
                    .graphicsLayer { translationX = -offset.value }
            } else Modifier,
        )
    }
}
