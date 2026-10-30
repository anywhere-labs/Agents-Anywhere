package com.agentsanywhere.app.ui.screens.sessiondetail

import android.content.Intent
import androidx.compose.ui.res.stringResource
import com.agentsanywhere.app.R
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.window.Dialog
import com.agentsanywhere.app.api.PlanDocument
import com.agentsanywhere.app.api.RemotePlanningState
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.ChevronUp
import com.composables.icons.lucide.FileText
import com.composables.icons.lucide.ListChecks
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.PencilLine
import com.composables.icons.lucide.RotateCcw
import com.composables.icons.lucide.Send

private data class PlanningCard(val id: String, val document: PlanDocument? = null, val draft: com.agentsanywhere.app.api.PlanDraft? = null)

@Composable
internal fun SessionPlanningPanel(state: RemotePlanningState?, darkMode: Boolean) {
    if (state == null || (state.effectiveMode != "plan" && state.draft == null && state.proposal == null && state.documents.isEmpty())) return
    var reader by remember(state.sessionId) { mutableStateOf<PlanDocument?>(null) }
    val positions = remember(state.sessionId) { mutableMapOf<String, androidx.compose.foundation.ScrollState>() }
    val context = LocalContext.current
    val exportTitle = stringResource(R.string.planning_export_title)
    val cards = (state.documents + listOfNotNull(state.proposal)).distinctBy { it.planId to it.revision }.map { PlanningCard("${it.planId}:${it.revision}", document = it) } +
        listOfNotNull(state.draft?.let { PlanningCard("${it.planId}:${it.revision}", draft = it) })
    val colors = LocalAAColors.current
    val mode = if (state.effectiveMode == "plan") stringResource(R.string.planning_mode) else null
    val execution = state.executionStatus?.let { when (it) { "started" -> stringResource(R.string.planning_execution_started); "accepted" -> stringResource(R.string.planning_execution_accepted); "rejected" -> stringResource(R.string.planning_execution_rejected); else -> stringResource(R.string.planning_execution_uncertain) } }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (mode != null || execution != null) Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Lucide.ListChecks, contentDescription = null, tint = colors.muted, modifier = Modifier.size(14.dp))
            Text(listOfNotNull(mode, execution).joinToString(" · "), color = colors.muted, fontSize = 12.sp)
        }
        cards.forEach { entry -> key(entry.id) {
            PlanCard(entry, darkMode, onRead = { reader = it })
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
                        TextButton(onClick = { (context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager).setPrimaryClip(android.content.ClipData.newPlainText(document.title, document.markdown)) }) { Text(stringResource(R.string.planning_copy)) }
                        TextButton(onClick = { context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/markdown").putExtra(Intent.EXTRA_TEXT, document.markdown).putExtra(Intent.EXTRA_TITLE, "PLAN.md"), exportTitle)) }) { Text(stringResource(R.string.planning_export)) }
                        TextButton(onClick = { reader = null }) { Text(stringResource(R.string.planning_close)) }
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
    Text(if (writing) stringResource(R.string.planning_writing) else stringResource(R.string.planning_interrupted), color = LocalAAColors.current.ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.alpha(opacity.value).onGloballyPositioned { coordinates ->
        val bounds = coordinates.boundsInWindow()
        val window = android.graphics.Rect().also(view::getWindowVisibleDisplayFrame)
        visible = bounds.bottom > window.top && bounds.top < window.bottom
    })
}

private val PlanPreviewHeight = 240.dp

// The card header already shows the title; drop a leading Markdown line that repeats it.
private fun planBody(document: PlanDocument): String {
    val markdown = document.markdown.replace(Regex("^\\s*\\n"), "")
    val heading = markdown.substringBefore('\n').replace(Regex("^#{1,6}\\s+"), "").removeSurrounding("**").trim()
    return if (heading.isNotEmpty() && heading == document.title.trim()) markdown.substringAfter('\n', "").replace(Regex("^\\s*\\n"), "") else markdown
}

@Composable
private fun PlanCard(entry: PlanningCard, darkMode: Boolean, onRead: (PlanDocument) -> Unit) {
    val colors = LocalAAColors.current
    val shape = RoundedCornerShape(16.dp)
    val document = entry.document
    val text = entry.draft?.content ?: document?.let(::planBody).orEmpty()
    var expanded by remember { mutableStateOf(false) }
    var fullHeight by remember { mutableIntStateOf(0) }
    val collapsible = document != null && fullHeight > with(LocalDensity.current) { PlanPreviewHeight.roundToPx() }
    val clamped = collapsible && !expanded
    Column(
        Modifier.fillMaxWidth().clip(shape).background(colors.canvas).border(1.dp, colors.border, shape).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(9.dp), verticalAlignment = Alignment.Top) {
            Icon(Lucide.FileText, contentDescription = null, tint = colors.muted, modifier = Modifier.size(17.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                entry.draft?.let { PlanningWritingTitle(it.contentState == "drafting") }
                    ?: Text(document!!.title, color = colors.ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                Text(if (entry.draft != null) stringResource(R.string.planning_streaming) else stringResource(R.string.planning_document_version, document!!.revision), color = colors.muted, fontSize = 12.sp)
            }
            document?.let { PlanActionButton(stringResource(R.string.planning_open), onClick = { onRead(it) }) }
        }
        Box(Modifier.fillMaxWidth().padding(start = 26.dp).then(if (clamped) Modifier.height(PlanPreviewHeight) else Modifier).clipToBounds()) {
            Box(Modifier.fillMaxWidth().wrapContentHeight(Alignment.Top, unbounded = true).onSizeChanged { fullHeight = it.height }) {
                AgentMarkdownText(text, darkMode, onOpenFile = {})
            }
            if (clamped) Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(48.dp).background(Brush.verticalGradient(listOf(Color.Transparent, colors.canvas))))
        }
        if (collapsible) Row(
            Modifier.padding(start = 26.dp).heightIn(min = 32.dp).noRippleClickable { expanded = !expanded },
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(if (expanded) Lucide.ChevronUp else Lucide.ChevronDown, contentDescription = null, tint = colors.inkSoft, modifier = Modifier.size(14.dp))
            Text(if (expanded) stringResource(R.string.planning_collapse) else stringResource(R.string.planning_expand), color = colors.inkSoft, fontSize = 12.sp, fontWeight = FontWeight.Medium)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun PlanningReviewPanel(target: RemotePlanningState, busy: Boolean, onRespond: (String, String) -> Unit) {
    val document = target.proposal ?: return
    val review = target.review ?: return
    val colors = LocalAAColors.current
    val identity = arrayOf<Any>(target.sessionId, target.epoch, review.reviewId, document.planId, document.revision, document.contentHash)
    var feedback by remember(*identity) { mutableStateOf("") }
    var editing by remember(*identity) { mutableStateOf(false) }
    var pending by remember(*identity) { mutableStateOf<String?>(null) }
    val focus = remember { FocusRequester() }
    val open = review.status == "open"
    fun allowed(action: String) = target.freshness == "fresh" && target.epoch.isNotEmpty() && target.actions?.contains(action) == true
    fun respond(action: String) {
        if (busy || !allowed(action)) return
        pending = action
        onRespond(action, if (action == "request_revision") feedback.trim() else "")
    }
    LaunchedEffect(editing) { if (editing) focus.requestFocus() }
    Box(Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, bottom = 4.dp)) {
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(22.dp)).background(colors.raisedSurface)
                .heightIn(max = 320.dp).verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(9.dp), verticalAlignment = Alignment.Top) {
                Icon(Lucide.ListChecks, contentDescription = null, tint = colors.muted, modifier = Modifier.size(17.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(if (open) stringResource(R.string.planning_review_title) else stringResource(R.string.planning_execution_rejected), color = colors.ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                    Text(stringResource(R.string.planning_version, document.revision), color = colors.muted, fontSize = 12.sp)
                    if (target.freshness != "fresh") Text(stringResource(R.string.planning_refresh_before_review), color = colors.muted, fontSize = 12.sp)
                }
            }
            if (editing) OutlinedTextField(
                value = feedback, onValueChange = { feedback = it }, placeholder = { Text(stringResource(R.string.planning_feedback_placeholder)) }, minLines = 2, maxLines = 4,
                enabled = !busy, modifier = Modifier.fillMaxWidth().focusRequester(focus),
            )
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                fun loading(action: String) = busy && pending == action
                when {
                    !open -> PlanActionButton(stringResource(R.string.planning_retry_start), Lucide.RotateCcw, primary = true, busy = loading("approve_and_execute"), enabled = !busy && allowed("approve_and_execute")) { respond("approve_and_execute") }
                    editing -> {
                        PlanActionButton(stringResource(R.string.planning_cancel), enabled = !busy) { editing = false }
                        PlanActionButton(stringResource(R.string.planning_submit_feedback), Lucide.Send, primary = true, busy = loading("request_revision"), enabled = !busy && allowed("request_revision") && feedback.isNotBlank()) { respond("request_revision") }
                    }
                    else -> {
                        PlanActionButton(stringResource(R.string.planning_dismiss), busy = loading("dismiss_review"), enabled = !busy && allowed("dismiss_review")) { respond("dismiss_review") }
                        PlanActionButton(stringResource(R.string.planning_revise), Lucide.PencilLine, enabled = !busy && allowed("request_revision")) { editing = true }
                        PlanActionButton(stringResource(R.string.planning_approve), Lucide.Check, primary = true, busy = loading("approve_and_execute"), enabled = !busy && allowed("approve_and_execute")) { respond("approve_and_execute") }
                    }
                }
            }
        }
    }
}

// Mirrors the composer-adjacent approval buttons so plan review reads as the same kind of decision.
@Composable
private fun PlanActionButton(label: String, icon: ImageVector? = null, primary: Boolean = false, busy: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    val colors = LocalAAColors.current
    val contentColor = if (primary) colors.onPrimaryAction else colors.ink
    Row(
        Modifier.widthIn(min = 68.dp).height(32.dp).clip(RoundedCornerShape(13.dp))
            .background(if (primary) colors.primaryAction else colors.secondaryActionSurface)
            .graphicsLayer { alpha = if (enabled || busy) 1f else 0.28f }
            .then(if (enabled && !busy) Modifier.noRippleClickable(onClick = onClick) else Modifier)
            .padding(horizontal = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (busy) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.8.dp, color = contentColor)
        else icon?.let { Icon(it, contentDescription = null, tint = contentColor, modifier = Modifier.size(14.dp)) }
        Text(label, color = contentColor, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
