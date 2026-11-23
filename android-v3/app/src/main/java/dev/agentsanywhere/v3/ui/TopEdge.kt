package dev.agentsanywhere.v3.ui

import com.kyant.backdrop.effects.blur
import com.kyant.backdrop.effects.runtimeShaderEffect
import com.kyant.backdrop.drawBackdrop
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.draw.drawWithContent
import dev.agentsanywhere.v3.design.continuousRect
import dev.agentsanywhere.v3.design.LocalWebBackdrop
import com.kyant.backdrop.backdrops.rememberLayerBackdrop
import com.kyant.backdrop.backdrops.layerBackdrop
import androidx.compose.runtime.CompositionLocalProvider
import android.os.Build
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.agentsanywhere.v3.design.AA
import dev.agentsanywhere.v3.design.claimTouches
import dev.agentsanywhere.v3.design.AAFonts
import dev.agentsanywhere.v3.design.AAMetrics
import dev.agentsanywhere.v3.design.AAMotion
import dev.agentsanywhere.v3.design.AASpinner
import dev.agentsanywhere.v3.design.AASymbol
import dev.agentsanywhere.v3.design.AAText
import dev.agentsanywhere.v3.design.GlassButton
import dev.agentsanywhere.v3.design.GlassCapsule
import dev.agentsanywhere.v3.design.GlassCircleButton
import dev.agentsanywhere.v3.design.GlassToolbarGroup
import dev.agentsanywhere.v3.design.GlassToolbarAction
import dev.agentsanywhere.v3.design.GlassMode
import dev.agentsanywhere.v3.design.LocalGlassMode
import dev.agentsanywhere.v3.design.MenuItem
import dev.agentsanywhere.v3.design.MenuRequest
import dev.agentsanywhere.v3.design.Press
import dev.agentsanywhere.v3.design.glass
import dev.agentsanywhere.v3.design.iosSpring
import dev.agentsanywhere.v3.design.pressable
import kotlinx.coroutines.delay

/**
 * iOS's soft scroll edge under the status bar and toolbar, as a fade of the page colour (blurring it would mean
 * recording the WebView). Top only; the bottom has none.
 */
@Composable
fun TopEdge(start: androidx.compose.ui.unit.Dp, exportTo: com.kyant.backdrop.backdrops.LayerBackdrop? = null) {
    val c = AA.colors
    val web = LocalWebBackdrop.current
    // iOS 26's scroll edge effect, from just below the header up to the screen top: two independent eased ramps that
    // both start at 0 at the band's bottom and grow to the top: the veil's opacity, and the blur radius.
    if (web == null) {
        // No blur (glass off, power saver, Android < 12): the page colour along the same range and curve.
        Box(Modifier.fillMaxWidth().height(start).background(easedRamp(c.toolbarEdgeTint, 1f, easeOut = true)))
        return
    }
    val maxRadius = AAMetrics.topEdgeMaxBlur
    Box(Modifier.fillMaxWidth().height(start)) {
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            // A truly variable blur: radius r(y) = maxRadius × ease(1 − y / h), separable (a horizontal pass, exact
            // because r is constant along a row, then a vertical pass with r(y)). r = 0 at the band's bottom, so the
            // blurred thread meets the sharp one without an edge.
            Box(Modifier.fillMaxSize().drawBackdrop(web, shape = { androidx.compose.ui.graphics.RectangleShape }, effects = {
                val w = size.width; val h = size.height; val r = maxRadius.toPx()
                runtimeShaderEffect("aa-vblur-h", VARIABLE_BLUR, "content") { setFloatUniform("size", w, h); setFloatUniform("maxRadius", r); setFloatUniform("dir", 1f, 0f) }
                runtimeShaderEffect("aa-vblur-v", VARIABLE_BLUR, "content") { setFloatUniform("size", w, h); setFloatUniform("maxRadius", r); setFloatUniform("dir", 0f, 1f) }
            }, highlight = null, shadow = null, exportedBackdrop = exportTo,
                // The veil is drawn as this backdrop's surface, so the exported result (what the toolbar buttons
                // sample) already has it.
                onDrawSurface = { drawRect(easedRamp(c.toolbarEdgeTint, AAMetrics.topEdgeVeil, easeOut = true)) }))
        } else {
            // Android 12: no runtime shaders. Fixed-radius layers, each faded in by an eased ramp over the whole band
            // (bigger radius ramps in later), so the strength still rises smoothly towards the top.
            listOf(maxRadius * 0.25f to 1f, maxRadius * 0.5f to 0.66f, maxRadius to 0.33f).forEach { (radius, reach) ->
                Box(
                    Modifier.fillMaxSize()
                        .graphicsLayer { compositingStrategy = androidx.compose.ui.graphics.CompositingStrategy.Offscreen }
                        .drawWithContent {
                            drawContent()
                            drawRect(easedRamp(Color.Black, 1f, reach), blendMode = androidx.compose.ui.graphics.BlendMode.DstIn)
                        }
                        .drawBackdrop(web, shape = { androidx.compose.ui.graphics.RectangleShape }, effects = { blur(radius.toPx()) },
                            highlight = null, shadow = null),
                )
            }
            Box(Modifier.fillMaxSize().background(easedRamp(c.toolbarEdgeTint, AAMetrics.topEdgeVeil, easeOut = true)))
        }
    }
}

/**
 * [color] transparent at the bottom, rising along smoothstep to [alpha] at the top; with [reach] < 1 it is only
 * non-zero in the top [reach] of the height. Enough stops that the curve shows no bands.
 */
private fun easedRamp(color: Color, alpha: Float, reach: Float = 1f, easeOut: Boolean = false): Brush {
    val steps = 24
    val stops = (0..steps).map { i ->
        val t = i / steps.toFloat()                       // 0 = top, 1 = bottom
        val x = ((1f - t) / reach).coerceIn(0f, 1f)        // 1 at the top, 0 at reach and below
        // smoothstep stays near 0 over the bottom third; the veil uses ease-out instead, so its opacity already
        // changes visibly right from where the band starts and levels off towards the top.
        val e = if (easeOut) 1f - (1f - x) * (1f - x) else x * x * (3f - 2f * x)
        t to color.copy(alpha = color.alpha * alpha * e)
    }
    return Brush.verticalGradient(*stops.toTypedArray())
}

/** Separable variable-radius Gaussian along `dir`; radius eased from 0 at the bottom to `maxRadius` at the top. */
private const val VARIABLE_BLUR = """
uniform shader content;
uniform float2 size;
uniform float maxRadius;
uniform float2 dir;
half4 main(float2 p) {
    float x = clamp(1.0 - p.y / size.y, 0.0, 1.0);
    float r = maxRadius * x * x * (3.0 - 2.0 * x);
    if (r < 0.5) return content.eval(p);
    half4 acc = half4(0.0);
    float total = 0.0;
    for (int i = 0; i < 25; i++) {
        float k = float(i) / 12.0 - 1.0;
        float w = exp(-k * k * 4.5);
        float2 q = clamp(p + dir * (k * r), float2(0.5), size - float2(0.5));
        acc += content.eval(q) * w;
        total += w;
    }
    return acc / total;
}
"""

