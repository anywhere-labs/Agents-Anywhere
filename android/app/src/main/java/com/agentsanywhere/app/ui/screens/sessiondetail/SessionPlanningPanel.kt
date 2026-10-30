package com.agentsanywhere.app.ui.screens.sessiondetail

import android.content.Intent
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.window.Dialog
import com.agentsanywhere.app.api.PlanDocument
import com.agentsanywhere.app.api.RemotePlanningState

private data class PlanningCard(val id: String, val document: PlanDocument? = null, val draft: com.agentsanywhere.app.api.PlanDraft? = null)

@Composable
internal fun SessionPlanningPanel(state: RemotePlanningState?, darkMode: Boolean, canReview: Boolean = true, onReview: () -> Unit) {
    if (state == null || (state.effectiveMode != "plan" && state.draft == null && state.proposal == null && state.documents.isEmpty())) return
    var reader by remember(state.sessionId) { mutableStateOf<PlanDocument?>(null) }
    val positions = remember(state.sessionId) { mutableMapOf<String, androidx.compose.foundation.ScrollState>() }
    val context = LocalContext.current
    val cards = (state.documents + listOfNotNull(state.proposal)).distinctBy { it.planId to it.revision }.map { PlanningCard("${it.planId}:${it.revision}", document = it) } +
        listOfNotNull(state.draft?.let { PlanningCard("${it.planId}:${it.revision}", draft = it) })
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(if (state.effectiveMode == "plan") "规划模式" else "计划", style = MaterialTheme.typography.labelLarge)
        state.executionStatus?.let { Text(when (it) { "started" -> "计划执行已开始"; "accepted" -> "执行请求已接受，等待原生开始"; "rejected" -> "计划已同意，执行尚未启动"; else -> "执行结果待核对" }) }
        cards.forEach { entry -> key(entry.id) {
            Card {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    entry.draft?.let { draft ->
                        PlanningWritingTitle(draft.contentState == "drafting")
                        AgentMarkdownText(draft.content, darkMode, onOpenFile = {})
                    }
                    entry.document?.let { document ->
                        Text(document.title, style = MaterialTheme.typography.titleMedium)
                        Text("计划 · 版本 ${document.revision}", style = MaterialTheme.typography.labelMedium)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = { reader = document }) { Text("打开计划") }
                            val retry = state.review?.status == "approved" && state.executionStatus == "rejected" && state.executionRetryable
                            if (state.review?.planId == document.planId && state.review.planRevision == document.revision && (state.review.status == "open" || retry)) {
                                TextButton(onClick = onReview, enabled = canReview && state.freshness == "fresh" && !state.actions.isNullOrEmpty()) { Text(if (retry) "重试启动" else "审阅计划") }
                            }
                        }
                    }
                }
            }
        } }
    }
    reader?.let { document ->
        val position = positions.getOrPut("${document.planId}:${document.revision}") { androidx.compose.foundation.ScrollState(0) }
        Dialog(onDismissRequest = { reader = null }, properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false)) {
            Surface(Modifier.fillMaxSize()) {
                Column(Modifier.systemBarsPadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(document.title, style = MaterialTheme.typography.titleLarge)
                    Box(Modifier.weight(1f).verticalScroll(position)) { AgentMarkdownText(document.markdown, darkMode, onOpenFile = {}) }
                    Row {
                        TextButton(onClick = { (context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager).setPrimaryClip(android.content.ClipData.newPlainText(document.title, document.markdown)) }) { Text("复制") }
                        TextButton(onClick = { context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/markdown").putExtra(Intent.EXTRA_TEXT, document.markdown).putExtra(Intent.EXTRA_TITLE, "PLAN.md"), "导出计划")) }) { Text("导出 Markdown") }
                        TextButton(onClick = { reader = null }) { Text("关闭") }
                    }
                }
            }
        }
    }
}

@Composable
private fun PlanningWritingTitle(writing: Boolean) {
    val view = androidx.compose.ui.platform.LocalView.current
    val owner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    var foreground by remember { mutableStateOf(owner.lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) }
    var visible by remember { mutableStateOf(false) }
    DisposableEffect(owner) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, _ -> foreground = owner.lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED) }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    val opacity = remember { androidx.compose.animation.core.Animatable(1f) }
    LaunchedEffect(writing, foreground, visible) {
        if (writing && foreground && visible && android.animation.ValueAnimator.areAnimatorsEnabled()) opacity.animateTo(.55f, infiniteRepeatable(tween(1200), RepeatMode.Reverse)) else opacity.snapTo(1f)
    }
    Text(if (writing) "正在撰写计划" else "计划草稿已中断", Modifier.alpha(opacity.value).onGloballyPositioned { coordinates ->
        val bounds = coordinates.boundsInWindow()
        val window = android.graphics.Rect().also(view::getWindowVisibleDisplayFrame)
        visible = bounds.bottom > window.top && bounds.top < window.bottom
    })
}

@Composable
internal fun PlanningReviewDialog(target: RemotePlanningState, current: RemotePlanningState?, darkMode: Boolean, busy: Boolean, canReview: Boolean = true,
    onDismiss: () -> Unit, onRespond: (String, String) -> Unit) {
    val document = target.proposal ?: return
    var feedback by remember(target.review?.reviewId) { mutableStateOf("") }
    val valid = canReview && current?.freshness == "fresh" && current.epoch == target.epoch && current.review?.reviewId == target.review?.reviewId && (current.review?.status == "open" || (current.review?.status == "approved" && current.executionStatus == "rejected" && current.executionRetryable)) && !current.actions.isNullOrEmpty()
    Dialog(onDismissRequest = { if (!busy) onDismiss() }) {
        Surface(shape = MaterialTheme.shapes.large) {
            Column(Modifier.imePadding().padding(20.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("是否执行这个计划？", style = MaterialTheme.typography.titleLarge)
                Text("${document.title} · 版本 ${document.revision}")
                Box(Modifier.weight(1f, fill = false).heightIn(max = 320.dp).verticalScroll(rememberScrollState())) { AgentMarkdownText(document.markdown, darkMode, onOpenFile = {}) }
                if (!valid) Text("审阅状态已变化，请刷新后重新打开当前计划。")
                OutlinedTextField(value = feedback, onValueChange = { feedback = it }, label = { Text("修改意见") }, enabled = !busy && target.review?.status == "open", modifier = Modifier.fillMaxWidth())
                Button(onClick = { onRespond("approve_and_execute", "") }, enabled = valid && !busy, modifier = Modifier.fillMaxWidth()) { Text(if (busy) "正在确认…" else if (target.review?.status == "approved") "重试启动" else "同意并执行") }
                TextButton(onClick = { onRespond("request_revision", feedback) }, enabled = valid && !busy && target.review?.status == "open" && feedback.isNotBlank(), modifier = Modifier.fillMaxWidth()) { Text("提交修改意见") }
                TextButton(onClick = { onRespond("dismiss_review", "") }, enabled = valid && !busy && target.review?.status == "open", modifier = Modifier.fillMaxWidth()) { Text("暂不执行") }
            }
        }
    }
}
