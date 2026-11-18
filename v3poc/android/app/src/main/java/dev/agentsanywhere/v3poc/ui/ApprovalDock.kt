package dev.agentsanywhere.v3poc.ui

import androidx.compose.foundation.layout.Box
import dev.agentsanywhere.v3poc.design.continuousRect
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import dev.agentsanywhere.v3poc.design.AA
import dev.agentsanywhere.v3poc.design.claimTouches
import dev.agentsanywhere.v3poc.design.textScrim
import dev.agentsanywhere.v3poc.design.AAFonts
import dev.agentsanywhere.v3poc.design.AAMetrics
import dev.agentsanywhere.v3poc.design.AASymbol
import dev.agentsanywhere.v3poc.design.AAText
import dev.agentsanywhere.v3poc.design.GlassButton
import dev.agentsanywhere.v3poc.design.GlassCircleButton
import dev.agentsanywhere.v3poc.design.MenuItem
import dev.agentsanywhere.v3poc.design.MenuRequest
import dev.agentsanywhere.v3poc.design.glass
import dev.agentsanywhere.v3poc.design.style
import dev.agentsanywhere.v3poc.model.PendingRequest

/**
 * The iOS `ApprovalDock` for `control.pending[0]`: title in monospace, one glass button per option by `name`,
 * `allow_once` prominent, rejects destructive. When the row does not fit, `allow_always` moves into a 更多 menu
 * (iOS `ViewThatFits`). The renderer only marks the waiting tool call (`chrome.approvals = 'host'`).
 */
@Composable
fun ApprovalDock(request: PendingRequest, agentLabel: String, count: Int, enabled: Boolean, ui: UiState, onAnswer: (String) -> Unit) {
    // The option buttons are glass on this glass: they sample the dock as drawn (OnGlass), not the thread.
    val dockBackdrop = com.kyant.backdrop.backdrops.rememberLayerBackdrop()
    Column(
        Modifier.padding(horizontal = AAMetrics.dockOuterHorizontalInset).fillMaxWidth()
            .glass(continuousRect(AAMetrics.dockCornerRadius), exportTo = dockBackdrop)
            .claimTouches()
            .padding(horizontal = AAMetrics.dockPaddingHorizontal, vertical = AAMetrics.dockPaddingVertical),
        verticalArrangement = Arrangement.spacedBy(AAMetrics.dockSpacing),
    ) {
        Row(Modifier.fillMaxWidth().defaultMinSize(minHeight = AAMetrics.dockHeaderMinHeight), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AASymbol("checkmark.shield", size = AAMetrics.dockIcon)
            Box(Modifier.weight(1f)) { AAText("$agentLabel 请求执行命令", Modifier.textScrim(), font = AAFonts.subheadline, weight = 600, maxLines = 1) }
            if (count > 1) AAText("1/$count", font = AAFonts.caption, color = AA.colors.controlSecondaryLabel)
        }
        AAText(request.title, Modifier.textScrim().fillMaxWidth().defaultMinSize(minHeight = (AAFonts.subheadline.lineHeight * 2).dp),
            font = AAFonts.subheadline, mono = true, color = AA.colors.controlSecondaryLabel, maxLines = 2, top = true)
        dev.agentsanywhere.v3poc.design.OnGlass(dockBackdrop) { BoxWithConstraints(Modifier.fillMaxWidth()) {
            val measurer = rememberTextMeasurer()
            val density = LocalDensity.current
            val style = AAFonts.subheadline.style()
            val pad = AAMetrics.glassButtonHorizontalPadding * 2
            fun need(options: List<PendingRequest.Option>, extra: Int = 0) = with(density) {
                options.sumOf { (measurer.measure(it.name, style).size.width + pad.roundToPx()) } + (options.size - 1 + extra) * 8.dp.roundToPx() +
                    extra * AAMetrics.glassButtonHeight.roundToPx()
            }
            val all = request.options
            val fits = need(all) <= with(density) { maxWidth.roundToPx() }
            val shown = if (fits) all else all.filter { it.kind != "allow_always" }
            val more = if (fits) emptyList() else all.filter { it.kind == "allow_always" }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (option in shown) {
                    GlassButton(option.name, if (option.kind == "allow_always") Modifier else Modifier.weight(1f),
                        prominent = option.kind == "allow_once", enabled = enabled, font = AAFonts.subheadline) { onAnswer(option.id) }
                }
                if (more.isNotEmpty()) {
                    var bounds by remember { mutableStateOf(Rect.Zero) }
                    GlassCircleButton("ellipsis", "更多", size = AAMetrics.glassButtonHeight, iconSize = 20.dp,
                        modifier = Modifier.onGloballyPositioned { bounds = it.boundsInRoot() }) {
                        ui.menu = MenuRequest(more.map { o -> MenuItem(o.name) { onAnswer(o.id) } }, bounds, alignEnd = true)
                    }
                }
            }
        } }
    }
}
