package dev.agentsanywhere.v3.ui

import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.agentsanywhere.v3.bridge.RenderBridge
import dev.agentsanywhere.v3.design.AA
import dev.agentsanywhere.v3.design.AAFonts
import dev.agentsanywhere.v3.design.AASpinner
import dev.agentsanywhere.v3.design.AASymbol
import dev.agentsanywhere.v3.design.AAText
import dev.agentsanywhere.v3.design.GlassButton
import dev.agentsanywhere.v3.design.continuousRect
import dev.agentsanywhere.v3.design.glass

/**
 * Hosts the bridge's one WebView for the screen identified by [owner]. Only the owner re-parents it, so during a
 * push / pop animation the incoming screen takes it and the outgoing one shows nothing there.
 * No pointer modifiers here or on any ancestor: touches on the page belong to the WebView alone; native controls are
 * siblings on top.
 */
@Composable
fun WebViewHost(bridge: RenderBridge, owner: Any, modifier: Modifier) {
    DisposableEffect(owner) {
        bridge.host = owner
        onDispose { if (bridge.host === owner) bridge.host = null }
    }
    Box(modifier) {
        AndroidView(
            factory = { context -> FrameLayout(context) },
            modifier = Modifier.fillMaxSize().graphicsLayer { alpha = if (bridge.isReady) 1f else 0f },
            update = { frame ->
                val view = bridge.webView
                @Suppress("UNUSED_VARIABLE") val generation = bridge.generation
                if (bridge.host === owner && view != null && view.parent !== frame) {
                    (view.parent as? ViewGroup)?.removeView(view)
                    frame.removeAllViews()
                    frame.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                }
            },
        )
        when (val phase = bridge.phase) {
            RenderBridge.Phase.Ready -> {}
            RenderBridge.Phase.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { AASpinner(20.dp) }
            is RenderBridge.Phase.Failed -> Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                Column(
                    Modifier.widthIn(max = 340.dp).glass(continuousRect(28.dp)).padding(28.dp),
                    horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    AASymbol("TriangleAlert", size = 28.dp, tint = Ios.colors.orange)
                    AAText("渲染器出错", font = AAFonts.headline)
                    AAText(phase.message, font = AAFonts.subheadline, color = Ios.colors.secondaryText, align = TextAlign.Center)
                    GlassButton("重试", onClick = { bridge.load() })
                }
            }
        }
    }
}

@Suppress("unused")
private val keepAA = AA
