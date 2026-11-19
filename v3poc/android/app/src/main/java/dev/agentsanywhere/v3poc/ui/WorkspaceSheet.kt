package dev.agentsanywhere.v3poc.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.agentsanywhere.v3poc.design.*
import dev.agentsanywhere.v3poc.model.SessionController

/** One toolbar entry for both workspace tools; real file/PTY services are not connected in the PoC. */
@Composable
fun WorkspaceSheet(controller: SessionController, ui: UiState) {
    AASheet(ui.workspaceSheet, onDismiss = { ui.workspaceSheet = false }) {
        var terminal by remember(controller.selectedId) { mutableStateOf(false) }
        SheetHeader("文件与终端") { ui.workspaceSheet = false }
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                GlassButton("文件", Modifier.weight(1f).semantics { role = Role.Tab; selected = !terminal },
                    symbol = "folder", prominent = !terminal) { terminal = false }
                GlassButton("终端", Modifier.weight(1f).semantics { role = Role.Tab; selected = terminal },
                    symbol = "terminal", prominent = terminal) { terminal = true }
            }
            controller.selectedSummary?.cwd?.takeIf { it.isNotBlank() }?.let { cwd ->
                AAText(cwd, font = AAFonts.footnote, color = AA.colors.secondaryLabel, mono = true)
            }
            Column(
                Modifier.fillMaxWidth().background(AA.colors.sheetCard, continuousRect(AAMetrics.sheetCardCornerRadius)).padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                AASymbol(if (terminal) "terminal" else "folder", size = 28.dp)
                AAText(if (terminal) "终端演示" else "文件演示", font = AAFonts.headline)
                AAText(
                    if (terminal) "当前为演示模式，暂未连接工作设备终端。" else "当前为演示模式，暂不读取工作设备文件。",
                    font = AAFonts.footnote, color = AA.colors.secondaryLabel,
                )
            }
        }
    }
}
