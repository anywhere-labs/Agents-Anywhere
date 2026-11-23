package dev.agentsanywhere.v3.design

import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.layout.layout
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.agentsanywhere.v3.R
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/** The AA design system on Compose foundation (no Material): tokens from v3poc/design/tokens.json, iOS look. */
val LocalAAColors = staticCompositionLocalOf { AALightColors }
val LocalDark = staticCompositionLocalOf { false }
val LocalContentColor = staticCompositionLocalOf { Color.Black }

@Composable
fun AATheme(dark: Boolean, content: @Composable () -> Unit) {
    val colors = if (dark) AADarkColors else AALightColors
    CompositionLocalProvider(LocalAAColors provides colors, LocalDark provides dark, LocalContentColor provides colors.label, content = content)
}

object AA {
    val colors: AAColors @Composable get() = LocalAAColors.current
}

// ── Text ────────────────────────────────────────────────────────────────────────────────────────────────────────

// iOS asks for `.weight(.medium)` but CoreText renders this variable font at its heaviest instance: the wordmark's ink
// coverage matches wght 700 exactly (347.9 vs 347.9; 500 would be 283.6). iOS is the reference, so Android uses 700.
val Caveat = FontFamily(Font(R.font.caveat, FontWeight.Bold, variationSettings = FontVariation.Settings(FontVariation.weight(700))))

fun AAFont.style(weight: Int? = null, mono: Boolean = false, color: Color = Color.Unspecified): TextStyle = TextStyle(
    fontSize = size.sp,
    lineHeight = lineHeight.sp,
    fontWeight = FontWeight(weight ?: this.weight),
    fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default,
    color = color,
    platformStyle = PlatformTextStyle(includeFontPadding = false),
    lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None),
)

/** `Text` in iOS terms: a Dynamic Type style (size, line height, weight), system font, content colour by default. */
@Composable
fun AAText(
    text: String,
    modifier: Modifier = Modifier,
    font: AAFont = AAFonts.body,
    color: Color = LocalContentColor.current,
    weight: Int? = null,
    mono: Boolean = false,
    maxLines: Int = Int.MAX_VALUE,
    align: TextAlign? = null,
    letterSpacing: TextUnit = TextUnit.Unspecified,
    /** Inside a taller frame (a minimum height), sit at the top instead of the centre (`alignment: .topLeading`). */
    top: Boolean = false,
) {
    val lines = remember { IntArray(1) }
    BasicText(
        text = text,
        modifier = modifier.singleLineNaturalHeight(font, lines, top),
        style = font.style(weight, mono, color).copy(textAlign = align ?: TextAlign.Unspecified, letterSpacing = letterSpacing),
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
        onTextLayout = { lines[0] = it.lineCount },
    )
}

/**
 * SwiftUI sizes a one-line `Text` by the SF font's own ascent + descent (≈ 1.19 × size), whatever script it shows.
 * Android grows a line to the fallback CJK font's taller metrics (Noto Sans CJK ≈ 1.45 × size) even with a fixed
 * line height, which made every Chinese row a few dp taller than on iOS. A one-line text therefore reports the SF
 * height and is centred in it (the glyphs may overhang by a pixel or two, as they do on iOS).
 */
private fun Modifier.singleLineNaturalHeight(font: AAFont, lines: IntArray, top: Boolean): Modifier = layout { measurable, constraints ->
    val placeable = measurable.measure(constraints.copy(minHeight = 0, maxHeight = Constraints.Infinity))
    val natural = (font.size * SF_LINE_HEIGHT).sp.roundToPx()
    val height = constraints.constrainHeight(if (lines[0] == 1) minOf(natural, placeable.height) else placeable.height)
    layout(placeable.width, height) {
        val box = if (lines[0] == 1) minOf(natural, placeable.height) else placeable.height
        placeable.place(0, if (top) (box - placeable.height) / 2 else (height - placeable.height) / 2)
    }
}

/** SF Pro's (ascender + descender) / unitsPerEm. */
private const val SF_LINE_HEIGHT = 1.193f

// ── Icons ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** iOS `AppSymbol`: the same Lucide vectors, by SF Symbol name ("doc.on.doc") or asset name ("Copy"). */
@Composable
fun AASymbol(name: String, modifier: Modifier = Modifier, size: Dp = AAMetrics.iconDefault, tint: Color = LocalContentColor.current) {
    Image(AAIcons.get(name), contentDescription = null, modifier = modifier.size(size), colorFilter = ColorFilter.tint(tint))
}

/** iOS `SessionAgentIcon`: the agent's mark, or Lucide Bot. */
@Composable
fun AgentIcon(agent: String, size: Dp = AAMetrics.sidebarAgentIcon, tint: Color = LocalContentColor.current) {
    val name = when (agent.lowercase().filter { it.isLetterOrDigit() }) {
        "codex" -> "AgentCodex"
        "claude", "claudecode" -> "AgentClaudeCode"
        "dsh", "deepseek", "deepseekharness" -> "AgentDeepSeek"
        else -> "Bot"
    }
    AASymbol(name, size = size, tint = tint)
}

/** iOS `AccountAvatarView`: the first letter on green. */
@Composable
fun AccountAvatar(name: String, size: Dp) {
    Box(Modifier.size(size).clip(CircleShape).background(AA.colors.avatar), contentAlignment = Alignment.Center) {
        AAText(name.firstOrNull()?.uppercase() ?: "?", font = AAFont(maxOf(size.value * 0.38f, 14f), maxOf(size.value * 0.38f, 14f) * 1.2f, 600), color = Color.White)
    }
}

/**
 * iOS `AAWordmark`: Caveat (rendered at wght 700, see [Caveat]). Caveat picks each letter's form with contextual alternates (`calt`) that depend on
 * the letters before it. iOS shapes the whole line; Android's text engine shapes and caches word by word, so the cycle
 * restarts at "Anywhere" and every letter after its A came out different (the y most visibly). The wordmark is fixed
 * text, so `calt` is off and each letter gets the form iOS / HarfBuzz choose for the whole line:
 * `A g e n.ss01 t.ss02 s ␣ A n.ss01 y.ss02 w h.ss01 e r.ss02 e.ss01`.
 */
private val WordmarkText = androidx.compose.ui.text.buildAnnotatedString {
    fun alt(c: Char, set: String) =
        withStyle(androidx.compose.ui.text.SpanStyle(fontFeatureSettings = "'calt' 0, '$set'")) { append(c) }
    append("Age"); alt('n', "ss01"); alt('t', "ss02"); append("s A")
    alt('n', "ss01"); alt('y', "ss02"); append("w"); alt('h', "ss01"); append("e"); alt('r', "ss02"); alt('e', "ss01")
    append("\u2009")
}

@Composable
fun AAWordmark(fontSize: Float = AAFonts.wordmark.size, modifier: Modifier = Modifier) {
    BasicText(WordmarkText, modifier, style = TextStyle(fontFamily = Caveat, fontWeight = FontWeight.Bold, fontSize = fontSize.sp,
        lineHeight = fontSize.sp, color = LocalContentColor.current, fontFeatureSettings = "'calt' 0",
        platformStyle = PlatformTextStyle(includeFontPadding = false)), maxLines = 1, softWrap = false)
}

/** iOS `ProgressView()`: eight spokes fading around, stepping 1/8 turn. */
@Composable
fun AASpinner(size: Dp = AAMetrics.spinner, color: Color = AA.colors.secondaryLabel) {
    val transition = rememberInfiniteTransition(label = "spinner")
    val step by transition.animateFloat(0f, 8f, infiniteRepeatable(tween(800, easing = LinearEasing), RepeatMode.Restart), label = "step")
    Canvas(Modifier.size(size)) {
        val r = this.size.minDimension / 2
        val head = step.toInt()
        for (i in 0 until 8) {
            val angle = (i / 8.0) * 2 * PI - PI / 2
            val alpha = 1f - (((head - i) % 8 + 8) % 8) / 8f * 0.85f
            val inner = r * 0.45f
            drawLine(color.copy(alpha = color.alpha * alpha),
                Offset(center.x + (inner * cos(angle)).toFloat(), center.y + (inner * sin(angle)).toFloat()),
                Offset(center.x + (r * 0.92f * cos(angle)).toFloat(), center.y + (r * 0.92f * sin(angle)).toFloat()),
                strokeWidth = r * 0.22f, cap = StrokeCap.Round)
        }
    }
}

// ── Press feedback (no ripple) ──────────────────────────────────────────────────────────────────────────────────

enum class Press { Dim, Scale, None }

/**
 * iOS-style press feedback instead of Material ripples: plain buttons dim while pressed; glass grows like a pressed
 * drop of liquid (`liquidScale`), with an underdamped spring so it overshoots a little going in and coming back.
 */
@Composable
fun Modifier.pressable(
    feedback: Press = Press.Dim,
    enabled: Boolean = true,
    role: Role = Role.Button,
    label: String? = null,
    interaction: MutableInteractionSource = remember { MutableInteractionSource() },
    onClick: () -> Unit,
): Modifier {
    val pressed by interaction.collectIsPressedAsState()
    val target = if (pressed && enabled) 1f else 0f
    val spec = when {
        feedback == Press.Scale -> AAMotion.liquidPress
        target == 1f -> spring(stiffness = Spring.StiffnessHigh)
        else -> spring(dampingRatio = 0.7f, stiffness = 500f)
    }
    val p by animateFloatAsState(target, spec, label = "press")
    return this
        .graphicsLayer {
            when (feedback) {
                Press.Dim -> alpha = 1f - (1f - AAMetrics.pressedOpacity) * p
                Press.Scale -> liquidScale(p)
                Press.None -> {}
            }
        }
        .clickable(interactionSource = interaction, indication = null, enabled = enabled, role = role, onClickLabel = label, onClick = onClick)
}

/**
 * A visible native control over the WebView (composer card, approval dock, toolbar title) takes the touches that land
 * on it, like a UIKit view under the finger: without this, a touch on its background would fall through to the thread.
 * Compose gives a touch to the topmost node that is hit, so a pointer node here keeps it from the WebView; the
 * control's own buttons and text field (children) still get theirs first. Only the control's bounds, never margins.
 */
fun Modifier.claimTouches(): Modifier = pointerInput(Unit) {
    awaitEachGesture {
        awaitFirstDown(requireUnconsumed = false)
        do { val event = awaitPointerEvent() } while (event.changes.any { it.pressed })
    }
}


/**
 * iOS glass under a finger grows instead of shrinking: a uniform scale, no stretching. `p` may overshoot past 1 or
 * below 0 with the underdamped spring; that is the liquid feel.
 */
fun androidx.compose.ui.graphics.GraphicsLayerScope.liquidScale(p: Float) {
    if (size.width <= 0f || size.height <= 0f) return
    // Uniform, by an absolute amount on the longer side, so a wide composer swells about as much as a 44 dp circle.
    val s = 1f + (AAMetrics.liquidPressGrow.toPx() / maxOf(size.width, size.height)).coerceAtMost(0.24f) * p
    scaleX = s
    scaleY = s
}

/**
 * The same liquid press for a control that is not a button (the composer card): it watches the finger without
 * consuming it, so the text field and buttons inside still get their touches.
 */
@Composable
fun Modifier.liquidPress(enabled: Boolean = true): Modifier {
    var down by remember { mutableStateOf(false) }
    val p by animateFloatAsState(if (down && enabled) 1f else 0f, AAMotion.liquidPress, label = "liquidPress")
    return this
        .pointerInput(enabled) {
            awaitEachGesture {
                awaitFirstDown(requireUnconsumed = false, pass = androidx.compose.ui.input.pointer.PointerEventPass.Initial)
                down = true
                do { val event = awaitPointerEvent(androidx.compose.ui.input.pointer.PointerEventPass.Initial) } while (event.changes.any { it.pressed })
                down = false
            }
        }
        .graphicsLayer { liquidScale(p) }
}
