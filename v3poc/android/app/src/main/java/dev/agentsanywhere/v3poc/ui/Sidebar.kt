package dev.agentsanywhere.v3poc.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.agentsanywhere.v3poc.design.AA
import dev.agentsanywhere.v3poc.design.AAFonts
import dev.agentsanywhere.v3poc.design.AAMetrics
import dev.agentsanywhere.v3poc.design.AASpinner
import dev.agentsanywhere.v3poc.design.AASymbol
import dev.agentsanywhere.v3poc.design.AAText
import dev.agentsanywhere.v3poc.design.AAWordmark
import dev.agentsanywhere.v3poc.design.AccountAvatar
import dev.agentsanywhere.v3poc.design.AgentIcon
import dev.agentsanywhere.v3poc.design.GlassButton
import dev.agentsanywhere.v3poc.design.GlassKind
import dev.agentsanywhere.v3poc.design.GlassMode
import dev.agentsanywhere.v3poc.design.LocalFrostedSource
import dev.agentsanywhere.v3poc.design.FrostedSource
import dev.agentsanywhere.v3poc.design.frostedSource
import dev.agentsanywhere.v3poc.design.LocalGlassMode
import dev.agentsanywhere.v3poc.design.MenuItem
import dev.agentsanywhere.v3poc.design.MenuRequest
import dev.agentsanywhere.v3poc.design.Press
import dev.agentsanywhere.v3poc.design.glass
import dev.agentsanywhere.v3poc.design.pressable
import dev.agentsanywhere.v3poc.model.SessionActivity
import dev.agentsanywhere.v3poc.model.SessionController
import dev.agentsanywhere.v3poc.model.Workspace

/** The iOS PoC's `SidebarView`: devices, pair, pinned, projects (by working folder) with their sessions, new session, account. */
@Composable
fun Sidebar(controller: SessionController, ui: UiState, onOpenSession: (String) -> Unit) {
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    var showsSessionList by rememberSaveable { mutableStateOf(false) }
    val collapsed = remember { mutableStateListOf<String>() }
    val sessions = controller.sessions.sortedWith(compareByDescending<Workspace.Session> { controller.activityOf(it.id) == SessionActivity.Running }.thenByDescending { it.updated_at })
    val glassMode = LocalGlassMode.current
    // The list is native content: the glass buttons over it may blur it (never the WebView).
    val source = if (glassMode != GlassMode.Off) remember { FrostedSource() } else null
    val inset = AAMetrics.sidebarContentInset

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().frostedSource(source).background(AA.colors.background)) {
            // Header: the wordmark under the status bar.
            Box(Modifier.padding(top = top).height(AAMetrics.sidebarHeaderHeight).fillMaxWidth().padding(horizontal = AAMetrics.sidebarHeaderPaddingHorizontal),
                contentAlignment = Alignment.CenterStart) { AAWordmark() }
            Column(
                Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState())
                    .padding(start = inset, end = inset, top = 10.dp, bottom = bottom + AAMetrics.sidebarListBottomPadding),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                SectionLabel("设备")
                for (device in controller.devices) DeviceRow(device, ui, controller)
                Row(
                    Modifier.fillMaxWidth().defaultMinSize(minHeight = AAMetrics.sidebarPairRowMinHeight)
                        .pressable { ui.demoSheet = "配对设备" to "演示环境：在电脑上运行 Connector，扫描这里的二维码即可配对。" }
                        .padding(horizontal = AAMetrics.sidebarRowPaddingHorizontal),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    AASymbol("plus")
                    AAText("配对设备", weight = 600)
                }
                val pinned = sessions.filter { it.pinned }
                if (pinned.isNotEmpty()) {
                    SectionLabel("已置顶")
                    Rows(pinned, inset = false, context = showsSessionList, controller, ui, onOpenSession)
                }
                if (showsSessionList) {
                    HeaderRow("最近") { ListMenuButton(ui, showsSessionList) { showsSessionList = it } }
                    Rows(sessions.filter { !it.pinned }, inset = false, context = true, controller, ui, onOpenSession)
                } else {
                    HeaderRow("项目") {
                        ListMenuButton(ui, showsSessionList) { showsSessionList = it }
                        IconControl("plus", "创建项目") { controller.showToast("演示：创建项目") }
                    }
                    for (project in controller.projects) {
                        val expanded = project.id !in collapsed
                        Row(Modifier.fillMaxWidth().padding(start = AAMetrics.sidebarRowPaddingHorizontal), verticalAlignment = Alignment.CenterVertically) {
                            Row(
                                Modifier.weight(1f).defaultMinSize(minHeight = 44.dp).pressable { if (expanded) collapsed += project.id else collapsed -= project.id },
                                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                AASymbol(if (expanded) "folder.fill" else "folder", size = AAMetrics.sidebarFolderIcon)
                                AAText(project.name, Modifier.weight(1f), maxLines = 1)
                            }
                            Box(Modifier.size(44.dp).pressable { controller.showToast("演示：在 ${project.name} 中新建会话") }, contentAlignment = Alignment.Center) {
                                AASymbol("square.and.pencil", size = 18.dp)
                            }
                        }
                        if (expanded) Rows(sessions.filter { it.device_id == project.device_id && it.cwd == project.cwd }, inset = true, context = false, controller, ui, onOpenSession)
                    }
                    val unassigned = sessions.filter { s -> controller.projects.none { it.device_id == s.device_id && it.cwd == s.cwd } }
                    if (unassigned.isNotEmpty()) {
                        SectionLabel("未分组会话")
                        Rows(unassigned, inset = false, context = false, controller, ui, onOpenSession)
                    }
                }
            }
        }
        // Bottom bar: 新会话 (prominent glass) and the account button, over the list.
        CompositionLocalProvider(LocalFrostedSource provides source) {
            Row(
                Modifier.align(Alignment.BottomStart).fillMaxWidth()
                    .padding(start = AAMetrics.sidebarBottomBarPadding, end = AAMetrics.sidebarBottomBarPadding, bottom = maxOf(bottom, AAMetrics.sidebarBottomBarMinBottom)),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                GlassButton("新会话", symbol = "square.and.pencil", prominent = true) { controller.showToast("演示：新会话") }
                Spacer(Modifier.weight(1f))
                val interaction = remember { MutableInteractionSource() }
                val pressed by interaction.collectIsPressedAsState()
                Box(
                    Modifier.size(52.dp).pressable(Press.Scale, label = "账号", interaction = interaction) { ui.accountSheet = true }
                        .glass(CircleShape, GlassKind.Regular, if (pressed) 1f else 0f),
                    contentAlignment = Alignment.Center,
                ) { AccountAvatar(controller.account.name, AAMetrics.sidebarAvatar) }
            }
        }
    }
}

@Composable
private fun SectionLabel(title: String) {
    AAText(title, Modifier.padding(start = AAMetrics.sidebarRowPaddingHorizontal, end = AAMetrics.sidebarRowPaddingHorizontal,
        top = AAMetrics.sidebarSectionTop, bottom = AAMetrics.sidebarSectionBottom),
        font = AAFonts.subheadline, weight = 600, color = AA.colors.secondaryLabel)
}

@Composable
private fun HeaderRow(title: String, trailing: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = AAMetrics.sidebarRowPaddingHorizontal, end = AAMetrics.sidebarRowPaddingHorizontal, top = AAMetrics.sidebarProjectsHeaderTop),
        verticalAlignment = Alignment.CenterVertically) {
        AAText(title, Modifier.weight(1f).defaultMinSize(minHeight = 44.dp), font = AAFonts.subheadline, weight = 600, color = AA.colors.secondaryLabel)
        trailing()
    }
}

@Composable
private fun IconControl(symbol: String, label: String, onBounds: ((Rect) -> Unit)? = null, onClick: () -> Unit) {
    Box(Modifier.size(44.dp).then(if (onBounds != null) Modifier.onGloballyPositioned { onBounds(it.boundsInRoot()) } else Modifier)
        .pressable(label = label, onClick = onClick), contentAlignment = Alignment.Center) { AASymbol(symbol) }
}

@Composable
private fun ListMenuButton(ui: UiState, showsSessionList: Boolean, onChange: (Boolean) -> Unit) {
    var bounds by remember { mutableStateOf(Rect.Zero) }
    IconControl("ellipsis", "列表选项", onBounds = { bounds = it }) {
        ui.menu = MenuRequest(listOf(
            MenuItem("按项目", if (!showsSessionList) "checkmark" else null) { onChange(false) },
            MenuItem("全部会话", if (showsSessionList) "checkmark" else null) { onChange(true) },
        ), bounds, alignEnd = true)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DeviceRow(device: Workspace.Device, ui: UiState, controller: SessionController) {
    var bounds by remember { mutableStateOf(Rect.Zero) }
    val haptics = LocalHapticFeedback.current
    Row(
        Modifier.fillMaxWidth().defaultMinSize(minHeight = AAMetrics.sidebarRowMinHeight)
            .onGloballyPositioned { bounds = it.boundsInRoot() }
            .combinedClickable(remember { MutableInteractionSource() }, null, onLongClick = {
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                ui.menu = MenuRequest(listOf(
                    MenuItem("设备详情", "info.circle") { controller.showToast("演示：设备详情") },
                    MenuItem("复制设备名称", "doc.on.doc") { controller.copy(device.name); controller.showToast("已复制") },
                ), bounds)
            }) {}
            .padding(horizontal = AAMetrics.sidebarRowPaddingHorizontal),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(Modifier.size(AAMetrics.sidebarDeviceDot).background(if (device.isOnline) AA.colors.green else AA.colors.secondaryLabel.copy(alpha = 0.45f), CircleShape))
        AAText(device.name, font = AAFonts.subheadline, mono = true, maxLines = 1, color = if (device.isOnline) AA.colors.label else AA.colors.secondaryLabel)
    }
}

@Composable
private fun Rows(list: List<Workspace.Session>, inset: Boolean, context: Boolean, controller: SessionController, ui: UiState, onOpen: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        list.forEachIndexed { index, session ->
            SessionRow(
                session = session,
                activity = controller.activityOf(session.id),
                selected = controller.selectedId == session.id,
                context = if (context) contextLine(controller, session, list.getOrNull(index - 1)) else null,
                divider = context && index < list.size - 1,
                inset = inset, ui = ui, controller = controller, onOpen = { onOpen(session.id) },
            )
        }
    }
}

private fun contextLine(controller: SessionController, s: Workspace.Session, previous: Workspace.Session?): String {
    val project = controller.projects.firstOrNull { it.device_id == s.device_id && it.cwd == s.cwd }?.name ?: s.cwd.split('/', '\\').lastOrNull()
    val device = if (previous?.device_id == s.device_id) "^" else controller.devices.firstOrNull { it.id == s.device_id }?.name ?: s.device_id
    return listOfNotNull(project, device).joinToString(" · ")
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SessionRow(
    session: Workspace.Session, activity: SessionActivity, selected: Boolean, context: String?, divider: Boolean, inset: Boolean,
    ui: UiState, controller: SessionController, onOpen: () -> Unit,
) {
    var bounds by remember { mutableStateOf(Rect.Zero) }
    val haptics = LocalHapticFeedback.current
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    // The selection fill bleeds to the sidebar's edges, through the content inset.
    val bleed: Dp = AAMetrics.sidebarContentInset
    Box(Modifier.fillMaxWidth().onGloballyPositioned { bounds = it.boundsInRoot() }) {
        if (selected || pressed) {
            Box(Modifier.matchParentSize().layoutBleed(bleed).background(AA.colors.sidebarSelectionFill.copy(alpha = if (selected) AA.colors.sidebarSelectionFill.alpha else AA.colors.sidebarSelectionFill.alpha * 0.6f)))
        }
        Column(
            Modifier.fillMaxWidth().defaultMinSize(minHeight = AAMetrics.sidebarRowMinHeight)
                .combinedClickable(interaction, null, onLongClick = {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    ui.menu = MenuRequest(listOf(
                        MenuItem("打开", "folder.fill", action = onOpen),
                        MenuItem(if (session.pinned) "取消置顶" else "置顶", if (session.pinned) "pin.slash" else "pin") { controller.togglePinned(session.id) },
                        MenuItem("复制会话 ID", "doc.on.doc", divider = true) { controller.copy(session.id); controller.showToast("已复制") },
                    ), bounds)
                }, onClick = onOpen)
                .padding(start = if (inset) AAMetrics.sidebarInsetRowLeading else AAMetrics.sidebarRowPaddingHorizontal, end = AAMetrics.sidebarRowPaddingHorizontal,
                    top = if (context == null) 0.dp else 8.dp, bottom = if (context == null) 0.dp else 8.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            Row(Modifier.fillMaxWidth().defaultMinSize(minHeight = if (context == null) AAMetrics.sidebarRowMinHeight else 0.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AgentIcon(session.agent)
                AAText(session.title, Modifier.weight(1f), maxLines = 1)
                SessionIndicator(activity, session.unread)
            }
            if (context != null) AAText(context, font = AAFonts.footnote, color = AA.colors.secondaryLabel, maxLines = 1)
        }
        if (divider) Box(Modifier.align(Alignment.BottomCenter).padding(horizontal = 10.dp).fillMaxWidth().height(0.5.dp).background(AA.colors.separator))
    }
}

/** Extends a background beyond the parent's horizontal padding (the iOS `chatSidebarRowBleed`). */
private fun Modifier.layoutBleed(bleed: Dp): Modifier = this.then(
    Modifier.layout { measurable, constraints ->
        val extra = bleed.roundToPx() * 2
        val placeable = measurable.measure(constraints.copy(minWidth = constraints.minWidth + extra, maxWidth = constraints.maxWidth + extra))
        layout(constraints.maxWidth, placeable.height) { placeable.place(-bleed.roundToPx(), 0) }
    },
)

/** The real app's `ChatSidebarSessionIndicator`, plus an error mark. */
@Composable
fun SessionIndicator(activity: SessionActivity, unread: Boolean) {
    when (activity) {
        SessionActivity.Waiting -> Box(Modifier.background(AA.colors.mint.copy(alpha = 0.16f), RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 3.dp)) {
            AAText("等待批准", font = dev.agentsanywhere.v3poc.design.AAFont(11f, 13f, 500), color = AA.colors.mint, maxLines = 1)
        }
        SessionActivity.Running -> AASpinner(14.dp, AA.colors.label.copy(alpha = 0.55f))
        SessionActivity.Error, SessionActivity.Disconnected -> AASymbol("exclamationmark.circle", size = 14.dp, tint = AA.colors.red)
        SessionActivity.Idle -> if (unread) Box(Modifier.size(AAMetrics.sidebarUnreadDot).background(AA.colors.green, CircleShape))
    }
}
