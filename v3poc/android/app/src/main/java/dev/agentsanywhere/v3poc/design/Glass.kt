package dev.agentsanywhere.v3poc.design

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.CornerBasedShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import android.os.Build
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.ClipOp
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.asAndroidPath
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.addOutline
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntSize
import com.kyant.backdrop.backdrops.LayerBackdrop
import com.kyant.backdrop.drawBackdrop
import com.kyant.backdrop.effects.blur
import com.kyant.backdrop.effects.lens
import com.kyant.backdrop.effects.vibrancy

/**
 * Blur radius (px, at full 「模糊程度」) for glass of this size: 2 dp at a 44 dp button, rising linearly with
 * √(width × height) to 10 dp at about 250 dp (the approval dock), clamped to 1.5–16 dp (a sheet).
 */
internal fun glassBlurRadius(width: Float, height: Float, density: androidx.compose.ui.unit.Density): Float = with(density) {
    val side = kotlin.math.sqrt(width * height).toDp().value
    val r = 2f + (side - 44f) / (250f - 44f) * 8f
    r.coerceIn(1.5f, 16f).dp.toPx()
}

/**
 * Content standing on a glass surface: glass inside it renders on top of that surface (Kyant `exportedBackdrop`)
 * instead of sampling the thread beneath and ignoring the surface. Pass the same [backdrop] to `glass(exportTo =)`.
 * When glass is off (no thread backdrop) nothing changes.
 */
@Composable
fun OnGlass(backdrop: LayerBackdrop, content: @Composable () -> Unit) {
    if (LocalWebBackdrop.current == null) content()
    else CompositionLocalProvider(LocalWebBackdrop provides backdrop, LocalNestedGlass provides true, content = content)
}

/** True inside [OnGlass]: buttons there stand on another glass and use the nested-button surface (iOS-measured). */
val LocalNestedGlass = staticCompositionLocalOf { false }

/** The 「模糊程度」 setting, 0 (clear: refraction, hardly any blur) … 1 (most frosted). See `GlassSettings.frost`. */
val LocalGlassFrost = androidx.compose.runtime.compositionLocalOf { 0.5f }

/** The effective glass mode (setting × API level × power saver), provided once at the root. */
val LocalGlassMode = staticCompositionLocalOf { GlassMode.Off }

/** Native content that frosted glass may blur (the sidebar list); the thread goes through `LocalWebBackdrop`. */
class FrostedSource {
    internal var layer: GraphicsLayer? = null
    internal var origin = Offset.Zero
    /** Bumped on every recording so the glass over it redraws (one frame later). */
    internal var version by mutableIntStateOf(0)
}

val LocalFrostedSource = staticCompositionLocalOf<FrostedSource?> { null }

/** Records this content (a native, non-WebView area) so `aaFrostedGlass` over it can blur it. */
@Composable
fun Modifier.frostedSource(source: FrostedSource?): Modifier {
    if (source == null) return this
    val layer = rememberGraphicsLayer()
    source.layer = layer
    return this
        .onGloballyPositioned { source.origin = it.positionInRoot() }
        .drawWithContent {
            layer.record { this@drawWithContent.drawContent() }
            drawLayer(layer)
            source.version++
        }
}

enum class GlassKind {
    /** `.glassEffect(.regular)`. */
    Regular,
    /** `.buttonStyle(.glass)` capsule, usually on another glass surface (the approval dock): a lighter step. */
    Button,
    /** `.glassProminent` tinted with the primary control colour (black in light mode). */
    Prominent,
    /** Sheets and menus: more opaque. */
    Sheet,
}

/**
 * The thread recorded for glass over it (Kyant `layerBackdrop` on the WebView host, the WebView drawing into its own
 * hardware layer). Null when glass is off: then nothing is recorded.
 */
val LocalWebBackdrop = staticCompositionLocalOf<LayerBackdrop?> { null }

/** How many sheets/menus are on screen; Root records the screen for their glass only while it is above zero. */
class OverlayCount { var value by mutableIntStateOf(0) }
val LocalOverlayCount = staticCompositionLocalOf<OverlayCount?> { null }

/** Call from a sheet/menu while it is composed (shown or animating out). */
@Composable
fun RegisterOverlay() {
    val count = LocalOverlayCount.current ?: return
    androidx.compose.runtime.DisposableEffect(count) { count.value++; onDispose { count.value-- } }
}

/**
 * `AAFrostedGlass`: the one glass look on Android. Translucent **only where it really blurs**:
 *  - over the thread with glass on: Kyant backdrop (blur + vibrancy, and lens refraction on Android 13+);
 *  - over recorded native content (sidebar, `LocalFrostedSource`) with glass on: a RenderEffect blur of it;
 *  - everywhere else (glass off, power saver, Android < 12, high contrast / no animations, nothing to blur): an
 *    opaque solid colour. The highlight stroke and the shadow stay in every case, so shapes and sizes never change.
 * Text colours on glass are chosen for the worst case (tools/contrast.py).
 */
@Composable
fun Modifier.glass(shape: Shape, kind: GlassKind = GlassKind.Regular, pressed: Float = 0f,
                   exportTo: LayerBackdrop? = null,
                   /** The size the blur radius follows, if not the drawn size (a sheet sliding off screen: its visible part). */
                   blurSize: (() -> androidx.compose.ui.geometry.Size)? = null): Modifier {
    val mode = LocalGlassMode.current
    val source = LocalFrostedSource.current
    val web = LocalWebBackdrop.current
    val c = AA.colors
    val dark = LocalDark.current
    if (kind == GlassKind.Prominent) {
        // Tinted glass is essentially opaque on iOS too; a highlight stroke keeps it glassy.
        return this
            .background(c.primaryControlBackground, shape)
            .border(1.dp, Brush.verticalGradient(listOf(Color.White.copy(alpha = if (dark) 0.5f else 0.28f), Color.Transparent)), shape)
            // Pressed: a tint of the opposite tone, clipped to the shape (a bare drawRect filled the whole bounds,
            // which showed as a pale rectangle around the capsule once the button grows under the finger).
            .drawBehind {
                if (pressed > 0f) drawOutline(shape.createOutline(size, layoutDirection, this),
                    (if (dark) Color.Black else Color.White).copy(alpha = 0.18f * pressed))
            }
    }
    val on = mode == GlassMode.Blur && Build.VERSION.SDK_INT >= 31
    val webBlur = on && web != null
    val nativeBlur = on && !webBlur && source != null && kind != GlassKind.Button
    val density = LocalDensity.current
    val radius = with(density) { (if (kind == GlassKind.Sheet) 30.dp else 16.dp).toPx() }
    // Solid / native-blur glass: the same top-and-bottom highlight as Kyant's, as a 1 dp edge that fades out at the sides.
    val stroke = Modifier.border(1.dp, Brush.verticalGradient(0f to c.glassStrokeTop, 0.3f to Color.Transparent,
        0.7f to Color.Transparent, 1f to c.glassStrokeBottom), shape)
    val solid = when (kind) {
        GlassKind.Sheet -> c.sheetBackgroundOpaque
        GlassKind.Button -> c.glassButtonTint
        else -> c.glassTintOpaque
    }
    val translucent = if (kind == GlassKind.Sheet) c.sheetBackground else c.glassTintBlur

    if (webBlur) {
        // Kyant's own material, with the parameters of its catalog (LiquidButton for buttons and capsules,
        // LiquidBottomTabs' container for panels): vibrancy, a small blur, lens refraction (Android 13+; 12 only
        // blurs), Kyant's highlight and shadow, a light surface tint. No stroke or shadow of ours.
        val panel = kind == GlassKind.Sheet || (kind == GlassKind.Regular && shape !is com.kyant.shapes.Capsule && shape != CircleShape && !isCapsule(shape))
        val nested = !panel && LocalNestedGlass.current
        // `dialog`: the catalog's DialogContent instead (lighter tint 0.6, blur 16 / 8 dp, deeper lens, plain highlight).
        val dialog = panel && dev.agentsanywhere.v3poc.DebugLaunch.panel == "dialog"
        // 「模糊程度」: blur radius and surface tint scale with it; refraction, highlight and the light lift do not, so
        // at 0 the glass is clear and still reads as glass through its lens and edges.
        val frost = LocalGlassFrost.current
        val baseSurface = when {
            dialog -> if (dark) c.liquidPanelSurface else c.liquidPanelSurface.copy(alpha = 0.6f)
            kind == GlassKind.Sheet -> c.liquidSheetSurface
            panel -> c.liquidPanelSurface
            nested -> c.liquidNestedButtonSurface
            else -> c.liquidButtonSurface
        }
        val surface = baseSurface.copy(alpha = baseSurface.alpha * (0.2f + 0.8f * frost))
        // The rim goes first in the chain so it draws last: on top of Kyant's top/bottom highlight, as on iOS (grey ring
        // outside, white highlight just inside it).
        return this.then(Modifier.rim(shape, dark)).drawBackdrop(
            backdrop = web,
            shape = { shape },
            // Glass placed on this glass (buttons on the approval dock, controls in a sheet) samples this glass as
            // drawn, not the thread under it: `exportTo` records it and the caller provides it as LocalWebBackdrop.
            exportedBackdrop = exportTo,
            effects = {
                vibrancy()
                // Like iOS, bigger glass blurs more: the radius follows the component's size (√(w·h), so a wide
                // composer sits between a 44 dp button and the approval dock), scaled by 「模糊程度」.
                val visible = blurSize?.invoke() ?: size
                // Even the clear endpoint samples a genuinely blurred backdrop; never draw translucent
                // glass with blur completely disabled. Half a physical pixel keeps this endpoint clear.
                val radius = (glassBlurRadius(visible.width, visible.height, this) * frost).coerceAtLeast(0.5f)
                blur(radius)
                if (Build.VERSION.SDK_INT >= 33) {
                    when {
                        dialog -> lens(24.dp.toPx(), 48.dp.toPx(), depthEffect = true)
                        panel -> lens(24.dp.toPx(), 24.dp.toPx())
                        else -> lens(12.dp.toPx(), 24.dp.toPx())
                    }
                }
            },
            // iOS 27: a soft highlight along the top and bottom edges (angle 90° lights where the edge normal is
            // vertical; |d| lights both), not an even rim and not the catalog's 45° corners.
            highlight = { edgeHighlight(dark) },
            // Light mode, measured on iOS: a very faint, wide, unclipped shadow mostly below and around the ends
            // (1–3 levels on white), plus a soft darkening along the inner edge; dark mode has neither …
            // Both schemes, measured on iOS over white: a faint, wide, unclipped shadow mostly below (also in dark
            // mode, where it only shows over light content) and a slightly darker rim at the ends …
            shadow = { softShadow() },
            innerShadow = if (dark) null else ({ edgeInnerShadow() }),
            onDrawSurface = {
                drawRect(surface)
                // A light lift so glass over a flat colour still reads as a layer, as on iOS (over #000 iOS glass is
                // #202020–#242424; over #FFF its buttons are ~#F8F8F8 and its composer ~#FDFDFD).
                drawRect(if (panel) c.liquidPanelLift else if (nested) c.liquidNestedButtonLift else c.liquidButtonLift)
                if (pressed > 0f) drawRect(c.glassPressed.copy(alpha = c.glassPressed.alpha * pressed))
            },
        )
    }

    val blurLayer = if (nativeBlur) rememberGraphicsLayer() else null
    var origin by remember { mutableStateOf(Offset.Zero) }
    return this
        .then(if (nativeBlur) Modifier.onGloballyPositioned { origin = it.positionInRoot() } else Modifier)
        .drawBehind {
            val clip = Path().apply { addOutline(shape.createOutline(size, layoutDirection, this@drawBehind)) }
            val src = source?.layer
            if (blurLayer != null && src != null) {
                @Suppress("UNUSED_VARIABLE") val v = source.version
                blurLayer.renderEffect = BlurEffect(radius, radius, TileMode.Clamp)
                val dx = source.origin.x - origin.x
                val dy = source.origin.y - origin.y
                blurLayer.record(IntSize(size.width.toInt(), size.height.toInt())) {
                    drawRect(c.background)
                    translate(dx, dy) { drawLayer(src) }
                }
                clipPath(clip) { drawLayer(blurLayer) }
            }
            clipPath(clip) {
                // A source may not have recorded its first frame yet: stay opaque until it exists.
                drawRect(if (blurLayer != null && src != null) translucent else solid)
                if (pressed > 0f) drawRect(c.glassPressed.copy(alpha = c.glassPressed.alpha * pressed))
            }
        }
        .then(stroke)
        .then(Modifier.rim(shape, dark))
}

/**
 * Candidate `scrim` (`--es panel scrim`): text on a Kyant panel over the thread gets a soft backing of the panel's
 * own tint, as opaque as the worst case needs (contrast.py: 0.76 light / 0.73 dark), only behind the text.
 */
@Composable
fun Modifier.textScrim(): Modifier {
    if (dev.agentsanywhere.v3poc.DebugLaunch.panel != "scrim") return this
    if (LocalGlassMode.current != GlassMode.Blur || LocalWebBackdrop.current == null || Build.VERSION.SDK_INT < 31) return this
    val c = AA.colors
    val dark = LocalDark.current
    val color = c.liquidPanelSurface.copy(alpha = if (dark) 0.73f else 0.76f)
    return drawBehind {
        val padX = 6.dp.toPx(); val padY = 2.dp.toPx()
        drawRoundRect(color, topLeft = Offset(-padX, -padY), size = androidx.compose.ui.geometry.Size(size.width + 2 * padX, size.height + 2 * padY),
            cornerRadius = androidx.compose.ui.geometry.CornerRadius(8.dp.toPx()))
    }
}

/** `RoundedCornerShape(50)` (our capsules): buttons, toasts, 到底部. */
private fun isCapsule(shape: Shape): Boolean =
    shape is RoundedCornerShape && shape == RoundedCornerShape(50)

/**
 * … and a hairline dark rim that is darkest at the left and right ends (iOS light composer: 216 at its ends, 241 along
 * the top, against a 253 fill; dark-mode glass over white: 177 at its ends against a 182 fill).
 */
@Composable
private fun Modifier.rim(shape: Shape, dark: Boolean): Modifier {
    val c = AA.colors
    val ends = c.glassRimEnds
    val middle = c.glassRimMiddle
    val maxCorner = with(androidx.compose.ui.platform.LocalDensity.current) { 32.dp.toPx() }
    // A hairline: `border` rounds its width up to whole pixels (2 px here, 0.76 dp), so its strength is set by alpha,
    // matched to iOS by summed darkness across the edge at equal physical size (iOS: 2 px at 3x, 214/175 at the ends
    // and 240/230 along the top over 254). The dark part covers only the rounded ends — the
    // corner radius (half the height for capsules, at most 32 dp for panels), not a share of the width — so the long
    // top and bottom edges of a wide panel stay faint, as on iOS.
    val brush = remember(ends, middle, maxCorner) {
        object : androidx.compose.ui.graphics.ShaderBrush() {
            override fun createShader(size: androidx.compose.ui.geometry.Size): androidx.compose.ui.graphics.Shader {
                val f = if (size.width > 0f) (minOf(size.height / 2f, maxCorner) / size.width).coerceIn(0.01f, 0.5f) else 0.18f
                return androidx.compose.ui.graphics.LinearGradientShader(
                    from = Offset.Zero, to = Offset(size.width, 0f),
                    colors = listOf(ends, middle, middle, ends),
                    colorStops = listOf(0f, f, 1f - f, 1f),
                )
            }
        }
    }
    return this.border(0.5.dp, brush, shape)
}

/** The soft darkening just inside the edge of light-mode glass (a few dp deep, a little stronger along the top). */
private fun edgeInnerShadow() = com.kyant.backdrop.shadow.InnerShadow(
    radius = 6.dp,
    offset = DpOffset(0.dp, 1.dp),
    color = Color.Black.copy(alpha = 0.06f),
)

/** Light mode's faint outer shadow: wide, barely offset down, never clipped (Kyant draws it outside the shape). */
private fun softShadow() = com.kyant.backdrop.shadow.Shadow(
    radius = 16.dp,
    offset = DpOffset(0.dp, 3.dp),
    color = Color.Black.copy(alpha = 0.07f),
)

/** Kyant highlight along the top and bottom edges, soft and dim (iOS 27: dark rim ≈ fill + a few levels). */
internal fun edgeHighlight(dark: Boolean) = com.kyant.backdrop.highlight.Highlight(
    width = 1.dp,
    blurRadius = 1.dp,
    alpha = if (dark) 0.45f else 0.6f,
    style = com.kyant.backdrop.highlight.HighlightStyle.Default(angle = 90f, falloff = 2f),
)

/** iOS `AppGlassButton` (capsule, `controlSize(.large)`): regular glass or prominent (black / white). */
@Composable
fun GlassButton(
    title: String?,
    modifier: Modifier = Modifier,
    symbol: String? = null,
    prominent: Boolean = false,
    destructive: Boolean = false,
    enabled: Boolean = true,
    font: AAFont = AAFonts.body,
    height: Dp = AAMetrics.glassButtonHeight,
    onClick: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val c = AA.colors
    val content = when {
        prominent -> c.primaryControlForeground
        destructive -> c.red
        else -> c.label
    }
    val shape = if (title == null) CircleShape else RoundedCornerShape(50)
    Box(
        modifier
            .height(height)
            .then(if (title == null) Modifier.width(height) else Modifier)
            .pressable(Press.Scale, enabled, interaction = interaction, onClick = onClick)
            .glass(shape, if (prominent) GlassKind.Prominent else GlassKind.Button, if (pressed) 1f else 0f)
            .padding(horizontal = if (title == null) 0.dp else AAMetrics.glassButtonHorizontalPadding),
        contentAlignment = Alignment.Center,
    ) {
        CompositionLocalProvider(LocalContentColor provides content.copy(alpha = if (enabled) 1f else 0.4f)) {
            Row(horizontalArrangement = Arrangement.spacedBy(AAMetrics.glassButtonIconGap), verticalAlignment = Alignment.CenterVertically) {
                symbol?.let { AASymbol(it) }
                title?.let { AAText(it, font = font, maxLines = 1) }
            }
        }
    }
}

/** The toolbar / sheet circle buttons (44 dp glass circles). */
@Composable
fun GlassCircleButton(symbol: String, label: String, size: Dp = AAMetrics.toolbarButtonDiameter, iconSize: Dp = AAMetrics.toolbarIcon,
                      modifier: Modifier = Modifier, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Box(
        modifier.size(size)
            .pressable(Press.Scale, label = label, interaction = interaction, onClick = onClick)
            .glass(CircleShape, pressed = if (pressed) 1f else 0f),
        contentAlignment = Alignment.Center,
    ) { AASymbol(symbol, size = iconSize) }
}

/** One glass surface and press spring for adjacent toolbar actions, as in iOS ToolbarItemGroup. */
@Composable
fun GlassToolbarGroup(content: @Composable RowScope.(MutableInteractionSource) -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val progress by animateFloatAsState(if (pressed) 1f else 0f, AAMotion.liquidPress, label = "toolbarGroupPress")
    Row(
        Modifier.graphicsLayer { liquidScale(progress) }
            .glass(RoundedCornerShape(50), pressed = if (pressed) 1f else 0f),
        verticalAlignment = Alignment.CenterVertically,
    ) { content(interaction) }
}

/** A separate accessible hit target inside a shared glass toolbar, without its own rim or background. */
@Composable
fun GlassToolbarAction(symbol: String, label: String, interaction: MutableInteractionSource,
                       modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(
        modifier.size(AAMetrics.toolbarButtonDiameter)
            .pressable(Press.None, label = label, interaction = interaction, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { AASymbol(symbol, size = AAMetrics.toolbarIcon) }
}

/** A glass capsule label (到底部, toasts). */
@Composable
fun GlassCapsule(modifier: Modifier = Modifier, minHeight: Dp, horizontal: Dp, vertical: Dp = 0.dp, content: @Composable () -> Unit) {
    Box(
        modifier.defaultMinSize(minHeight = minHeight).glass(RoundedCornerShape(50)).padding(horizontal = horizontal, vertical = vertical),
        contentAlignment = Alignment.Center,
    ) { content() }
}

@Suppress("unused")
private fun Modifier.fullWidth() = fillMaxWidth()

