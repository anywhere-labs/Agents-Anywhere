package dev.agentsanywhere.v3.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.agentsanywhere.v3.design.AA
import dev.agentsanywhere.v3.design.AAFont
import dev.agentsanywhere.v3.design.AAFonts
import dev.agentsanywhere.v3.design.AASpinner
import dev.agentsanywhere.v3.design.AASymbol
import dev.agentsanywhere.v3.design.AAText
import dev.agentsanywhere.v3.design.LocalContentColor
import dev.agentsanywhere.v3.design.LocalDark
import dev.agentsanywhere.v3.design.Press
import dev.agentsanywhere.v3.design.continuousRect
import dev.agentsanywhere.v3.design.pressable
import dev.agentsanywhere.v3.design.style

/**
 * iOS grouped-list colours (UIKit semantic colours) on top of the AA tokens. Text colours keep ≥ 4.5:1 and icons
 * ≥ 3:1 on their cell in both schemes: the stock iOS green / orange / red / blue are too light on white, so light
 * mode uses Apple's accessible (increased contrast) variants.
 */
@Immutable
data class IosColors(
    val groupedBackground: Color,
    val cell: Color,
    val cellPressed: Color,
    val separator: Color,
    val secondaryText: Color,
    val tertiaryText: Color,
    val tint: Color,
    val green: Color,
    val orange: Color,
    val red: Color,
    val fill: Color,
)

val IosLight = IosColors(
    groupedBackground = Color(0xFFF2F2F7), cell = Color.White, cellPressed = Color(0xFFD1D1D6),
    separator = Color(0x4A3C3C43), secondaryText = Color(0xE03C3C43), tertiaryText = Color(0xB33C3C43),
    tint = Color(0xFF0040DD), green = Color(0xFF248A3D), orange = Color(0xFFC93400), red = Color(0xFFD70015),
    fill = Color(0x1F767680),
)

val IosDark = IosColors(
    groupedBackground = Color.Black, cell = Color(0xFF1C1C1E), cellPressed = Color(0xFF3A3A3C),
    separator = Color(0xA6545458), secondaryText = Color(0xBFEBEBF5), tertiaryText = Color(0x99EBEBF5),
    tint = Color(0xFF409CFF), green = Color(0xFF30D158), orange = Color(0xFFFF9F0A), red = Color(0xFFFF6961),
    fill = Color(0x3D767680),
)

object Ios {
    val colors: IosColors @Composable get() = if (LocalDark.current) IosDark else IosLight
}

/**
 * iOS navigation bar (inline): ‹ back · centred title · trailing actions, on the opaque grouped background (no
 * translucency without real blur). The status bar inset is included.
 */
@Composable
fun NavBar(
    title: String,
    subtitle: String? = null,
    onBack: (() -> Unit)? = null,
    backLabel: String = "返回",
    background: Color = Ios.colors.groupedBackground,
    trailing: @Composable RowScope.() -> Unit = {},
) {
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    Box(Modifier.fillMaxWidth().background(background).padding(top = top).height(44.dp)) {
        if (onBack != null) {
            Row(
                Modifier.align(Alignment.CenterStart).padding(start = 4.dp).height(44.dp).pressable(Press.Dim, label = backLabel, onClick = onBack).padding(end = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AASymbol("ChevronLeft", size = 26.dp, tint = Ios.colors.tint)
                AAText(backLabel, font = AAFonts.body, color = Ios.colors.tint, maxLines = 1)
            }
        }
        Column(Modifier.align(Alignment.Center).padding(horizontal = 96.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            AAText(title, Modifier.semantics { heading() }, font = AAFonts.headline, maxLines = 1)
            subtitle?.let { AAText(it, font = AAFonts.caption, color = Ios.colors.secondaryText, maxLines = 1) }
        }
        Row(Modifier.align(Alignment.CenterEnd).padding(end = 8.dp), verticalAlignment = Alignment.CenterVertically, content = trailing)
    }
}

/** A tappable SF-style symbol in a navigation bar (44 dp target). */
@Composable
fun BarButton(symbol: String, label: String, enabled: Boolean = true, onClick: () -> Unit) {
    Box(Modifier.size(44.dp).pressable(Press.Dim, enabled = enabled, label = label, onClick = onClick), contentAlignment = Alignment.Center) {
        AASymbol(symbol, size = 22.dp, tint = Ios.colors.tint.copy(alpha = if (enabled) 1f else 0.4f))
    }
}

@Composable
fun BarTextButton(text: String, enabled: Boolean = true, bold: Boolean = false, onClick: () -> Unit) {
    Box(Modifier.defaultMinSize(minHeight = 44.dp).pressable(Press.Dim, enabled = enabled, onClick = onClick).padding(horizontal = 10.dp), contentAlignment = Alignment.Center) {
        AAText(text, font = AAFonts.body, weight = if (bold) 600 else null, color = Ios.colors.tint.copy(alpha = if (enabled) 1f else 0.4f))
    }
}

/** iOS large title (34 pt), under the navigation bar of a root screen. */
@Composable
fun LargeTitle(text: String, modifier: Modifier = Modifier) {
    AAText(text, modifier.padding(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 8.dp).semantics { heading() }, font = AAFonts.largeTitle, weight = 700, maxLines = 1)
}

/** `List { Section { … } header: footer: }` in the inset-grouped style. */
@Composable
fun GroupedSection(
    header: String? = null,
    footer: String? = null,
    modifier: Modifier = Modifier,
    headerTrailing: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        if (header != null) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 18.dp, bottom = 7.dp), verticalAlignment = Alignment.CenterVertically) {
                AAText(header, Modifier.weight(1f), font = AAFonts.footnote, color = Ios.colors.secondaryText, maxLines = 1)
                headerTrailing?.invoke()
            }
        } else Spacer(Modifier.height(18.dp))
        Column(Modifier.fillMaxWidth().clip(continuousRect(12.dp)).background(Ios.colors.cell), content = content)
        footer?.let { AAText(it, Modifier.padding(start = 16.dp, end = 16.dp, top = 7.dp), font = AAFonts.footnote, color = Ios.colors.secondaryText) }
    }
}

/** A list cell: optional leading icon, title / subtitle, trailing value or view, chevron; inset separator below. */
@Composable
fun ListRow(
    title: String,
    subtitle: String? = null,
    symbol: String? = null,
    symbolTint: Color? = null,
    leading: (@Composable () -> Unit)? = null,
    value: String? = null,
    trailing: (@Composable () -> Unit)? = null,
    chevron: Boolean = false,
    destructive: Boolean = false,
    titleColor: Color? = null,
    separator: Boolean = true,
    enabled: Boolean = true,
    onClick: (() -> Unit)? = null,
) {
    val c = Ios.colors
    val inset = if (symbol != null || leading != null) 58.dp else 16.dp
    Box(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth()
                .then(if (onClick != null) Modifier.pressable(Press.Dim, enabled = enabled, onClick = onClick) else Modifier)
                .defaultMinSize(minHeight = 44.dp)
                .padding(start = 16.dp, end = 14.dp, top = 10.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            when {
                leading != null -> { Box(Modifier.width(30.dp), contentAlignment = Alignment.Center) { leading() }; Spacer(Modifier.width(12.dp)) }
                symbol != null -> { Box(Modifier.width(30.dp), contentAlignment = Alignment.Center) { AASymbol(symbol, size = 22.dp, tint = symbolTint ?: c.tint) }; Spacer(Modifier.width(12.dp)) }
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                AAText(title, font = AAFonts.body, color = titleColor ?: if (destructive) c.red else AA.colors.label.copy(alpha = if (enabled) 1f else 0.4f), maxLines = 2)
                subtitle?.let { AAText(it, font = AAFonts.subheadline, color = c.secondaryText, maxLines = 2) }
            }
            value?.let { Spacer(Modifier.width(8.dp)); AAText(it, font = AAFonts.body, color = c.secondaryText, maxLines = 1) }
            trailing?.let { Spacer(Modifier.width(8.dp)); it() }
            if (chevron) { Spacer(Modifier.width(6.dp)); AASymbol("ChevronRight", size = 16.dp, tint = c.tertiaryText) }
        }
        if (separator) Box(Modifier.align(Alignment.BottomStart).padding(start = inset).fillMaxWidth().height(0.5.dp).background(c.separator))
    }
}

/** A coloured dot with a text label: state is never shown by colour alone. */
@Composable
fun StatusDot(color: Color, size: Dp = 8.dp) {
    Box(Modifier.size(size).background(color, CircleShape))
}

/** iOS segmented control. */
@Composable
fun SegmentedControl(options: List<String>, selected: Int, modifier: Modifier = Modifier, onSelect: (Int) -> Unit) {
    val c = Ios.colors
    val dark = LocalDark.current
    Row(modifier.fillMaxWidth().height(32.dp).background(c.fill, RoundedCornerShape(9.dp)).padding(2.dp)) {
        options.forEachIndexed { i, label ->
            val on = i == selected
            Box(
                Modifier.weight(1f).height(28.dp)
                    .then(if (on) Modifier.background(if (dark) Color(0xFF636366) else Color.White, RoundedCornerShape(7.dp)) else Modifier)
                    .pressable(Press.None, label = label) { onSelect(i) },
                contentAlignment = Alignment.Center,
            ) { AAText(label, font = AAFonts.footnote, weight = if (on) 600 else 500, maxLines = 1) }
        }
    }
}

/** A text field cell (iOS form style): placeholder in the field, no underline. */
@Composable
fun TextFieldRow(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    label: String? = null,
    secure: Boolean = false,
    keyboardType: KeyboardType = KeyboardType.Text,
    imeAction: ImeAction = ImeAction.Next,
    onDone: (() -> Unit)? = null,
    mono: Boolean = false,
    separator: Boolean = true,
) {
    val c = Ios.colors
    Box(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().defaultMinSize(minHeight = 44.dp).padding(horizontal = 16.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically) {
            label?.let { AAText(it, Modifier.width(92.dp), font = AAFonts.body, maxLines = 1) }
            Box(Modifier.weight(1f)) {
                if (value.isEmpty()) AAText(placeholder, font = AAFonts.body, color = c.tertiaryText, maxLines = 1)
                BasicTextField(
                    value = value,
                    onValueChange = onValueChange,
                    singleLine = true,
                    textStyle = AAFonts.body.style(mono = mono, color = AA.colors.label),
                    cursorBrush = SolidColor(c.tint),
                    visualTransformation = if (secure) PasswordVisualTransformation() else VisualTransformation.None,
                    keyboardOptions = KeyboardOptions(keyboardType = if (secure) KeyboardType.Password else keyboardType, imeAction = imeAction, autoCorrectEnabled = false),
                    keyboardActions = KeyboardActions(onDone = { onDone?.invoke() }, onGo = { onDone?.invoke() }),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        if (separator) Box(Modifier.align(Alignment.BottomStart).padding(start = 16.dp).fillMaxWidth().height(0.5.dp).background(c.separator))
    }
}

/** iOS `.borderedProminent` large button: capsule in the primary control colour (black / white). */
@Composable
fun ProminentButton(title: String, modifier: Modifier = Modifier, enabled: Boolean = true, loading: Boolean = false, onClick: () -> Unit) {
    val c = AA.colors
    Box(
        modifier.fillMaxWidth().height(50.dp).clip(RoundedCornerShape(50))
            .background(c.primaryControlBackground.copy(alpha = if (enabled) 1f else 0.3f))
            .pressable(Press.Dim, enabled = enabled && !loading, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (loading) AASpinner(18.dp, c.primaryControlForeground)
        else AAText(title, font = AAFonts.headline, color = c.primaryControlForeground.copy(alpha = if (enabled) 1f else 0.7f))
    }
}

/** A grey capsule (secondary action). */
@Composable
fun SecondaryButton(title: String, modifier: Modifier = Modifier, symbol: String? = null, onClick: () -> Unit) {
    Row(
        modifier.height(36.dp).clip(RoundedCornerShape(50)).background(Ios.colors.fill).pressable(Press.Dim, onClick = onClick).padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        symbol?.let { AASymbol(it, size = 16.dp) }
        AAText(title, font = AAFonts.subheadline, weight = 600, maxLines = 1)
    }
}

/** A small rounded badge ("加密", "离线"). */
@Composable
fun Badge(text: String, color: Color) {
    Box(Modifier.border(1.dp, color.copy(alpha = 0.6f), RoundedCornerShape(6.dp)).padding(horizontal = 6.dp, vertical = 1.dp)) {
        AAText(text, font = AAFonts.caption2, weight = 600, color = color, maxLines = 1)
    }
}

/** Centred empty / error state. */
@Composable
fun EmptyState(symbol: String, title: String, message: String? = null, action: (@Composable () -> Unit)? = null) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp)) {
        AASymbol(symbol, size = 40.dp, tint = Ios.colors.secondaryText)
        AAText(title, font = AAFonts.title3, weight = 600, align = androidx.compose.ui.text.style.TextAlign.Center)
        message?.let { AAText(it, font = AAFonts.subheadline, color = Ios.colors.secondaryText, align = androidx.compose.ui.text.style.TextAlign.Center) }
        action?.invoke()
    }
}

@Composable
fun ProvideContent(color: Color, content: @Composable () -> Unit) = CompositionLocalProvider(LocalContentColor provides color, content = content)

@Suppress("unused")
private val unusedFont = AAFont(1f, 1f, 400)
