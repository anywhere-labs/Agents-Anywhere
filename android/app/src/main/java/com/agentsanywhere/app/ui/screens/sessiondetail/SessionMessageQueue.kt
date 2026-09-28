package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessiondetail.QueuedMessageStatus
import com.agentsanywhere.app.feature.sessiondetail.QueuedSessionMessage
import com.agentsanywhere.app.feature.sessiondetail.SessionMessageQueueState
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.ArrowUp
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.ChevronUp
import com.composables.icons.lucide.Hand
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.MessageCircle
import com.composables.icons.lucide.Pencil
import com.composables.icons.lucide.Trash2
import com.composables.icons.lucide.X

@Composable
internal fun SessionMessageQueue(
    queue: SessionMessageQueueState,
    canSendNow: Boolean,
    onEdit: (String, Boolean, String?) -> Unit,
    onDelete: (String) -> Unit,
    onSendNow: (String) -> Unit,
) {
    if (queue.messages.isEmpty()) return
    val colors = LocalAAColors.current
    var expanded by remember { mutableStateOf(false) }
    val collapsible = queue.messages.size > 1 || queue.paused
    val editing = queue.messages.any { it.editing }
    val showRows = !collapsible || expanded || editing
    val shape = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp)
    Surface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 28.dp).border(1.dp, colors.border, shape),
        shape = shape,
        color = colors.subtle,
    ) {
        // The composer overlaps this lower inset so both surfaces meet at its rounded top edge.
        Column(Modifier.padding(bottom = 18.dp)) {
            if (collapsible) {
                Row(
                    modifier = Modifier.fillMaxWidth()
                        .then(if (editing) Modifier else Modifier.noRippleClickable { expanded = !expanded })
                        .padding(start = 12.dp, end = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    QueueStatusIcon(if (queue.messages.any { it.status == QueuedMessageStatus.Failed }) QueuedMessageStatus.Failed else QueuedMessageStatus.Queued)
                    Text(stringResource(R.string.session_queue_count, queue.messages.size), Modifier.weight(1f), color = colors.ink,
                        fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (queue.paused) Text(stringResource(R.string.session_queue_paused), color = colors.muted, fontSize = 11.sp)
                    IconButton(onClick = { expanded = !expanded }, enabled = !editing, modifier = Modifier.size(36.dp)) {
                        Icon(if (showRows) Lucide.ChevronDown else Lucide.ChevronUp,
                            stringResource(if (showRows) R.string.session_queue_collapse else R.string.session_queue_expand),
                            tint = colors.muted, modifier = Modifier.size(18.dp))
                    }
                }
                if (showRows) HorizontalDivider(color = colors.border.copy(alpha = 0.6f))
            }
            if (showRows) {
                Column(Modifier.heightIn(max = 192.dp).verticalScroll(rememberScrollState()).padding(vertical = 2.dp)) {
                    queue.messages.forEachIndexed { index, message ->
                        if (index > 0) HorizontalDivider(color = colors.border.copy(alpha = 0.6f), modifier = Modifier.padding(horizontal = 10.dp))
                        key(message.id) {
                            QueuedMessageRow(message, queue.paused, canSendNow && queue.messages.none { it.locked }, onEdit, onDelete, onSendNow)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun QueuedMessageRow(
    message: QueuedSessionMessage,
    paused: Boolean,
    canSendNow: Boolean,
    onEdit: (String, Boolean, String?) -> Unit,
    onDelete: (String) -> Unit,
    onSendNow: (String) -> Unit,
) {
    val colors = LocalAAColors.current
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    var draft by remember(message.id) { mutableStateOf(message.content) }
    val editLabel = stringResource(R.string.session_queue_edit)
    val canSave = draft.isNotBlank() || message.attachments.isNotEmpty()
    fun finishEditing(save: Boolean) {
        if (save && !canSave) return
        onEdit(message.id, false, if (save) draft else null)
        focusManager.clearFocus()
        keyboard?.hide()
    }
    fun startEditing() {
        draft = message.content
        onEdit(message.id, true, null)
    }
    DisposableEffect(message.id) { onDispose { onEdit(message.id, false, null) } }
    BackHandler(enabled = message.editing) { finishEditing(save = false) }
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = 42.dp).padding(start = 12.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        QueueStatusIcon(message.status)
        if (message.editing) {
            SessionComposerTextField(
                value = draft, onValueChange = { draft = it }, color = colors.ink,
                modifier = Modifier.weight(1f).heightIn(min = 44.dp, max = 108.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(colors.raisedSurface)
                    .border(1.dp, colors.border, RoundedCornerShape(10.dp))
                    .padding(horizontal = 12.dp, vertical = 10.dp)
                    .semantics { contentDescription = editLabel },
                autoFocus = true, imeAction = ImeAction.Done, submitEnabled = canSave,
                onSubmit = { finishEditing(save = true) },
            )
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                IconButton(enabled = canSave, onClick = { finishEditing(save = true) }, modifier = Modifier.size(36.dp)) {
                    Icon(Lucide.Check, stringResource(R.string.session_queue_save), tint = colors.ink, modifier = Modifier.size(18.dp))
                }
                IconButton(onClick = { finishEditing(save = false) }, modifier = Modifier.size(36.dp)) {
                    Icon(Lucide.X, stringResource(R.string.session_queue_cancel), tint = colors.ink, modifier = Modifier.size(18.dp))
                }
            }
        } else {
            val preview = message.content.ifBlank { stringResource(R.string.session_attachment_only_prompt) } +
                if (message.attachments.isEmpty()) "" else " (${message.attachments.joinToString { it.name }})"
            Text(
                text = preview, color = colors.ink, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).heightIn(min = 32.dp)
                    .then(if (message.locked) Modifier else Modifier.noRippleClickable { startEditing() })
                    .padding(vertical = 7.dp),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                IconButton(enabled = !message.locked, onClick = ::startEditing, modifier = Modifier.size(36.dp)) {
                    Icon(Lucide.Pencil, editLabel, tint = colors.ink, modifier = Modifier.size(18.dp))
                }
                IconButton(enabled = !message.locked, onClick = { onDelete(message.id) }, modifier = Modifier.size(36.dp)) {
                    Icon(Lucide.Trash2, stringResource(R.string.session_queue_delete), tint = colors.ink, modifier = Modifier.size(18.dp))
                }
                IconButton(enabled = !message.locked && !paused && canSendNow, onClick = { onSendNow(message.id) }, modifier = Modifier.size(36.dp)) {
                    Icon(Lucide.ArrowUp, stringResource(if (paused) R.string.session_queue_send_now_paused else R.string.session_queue_send_now),
                        tint = colors.ink, modifier = Modifier.size(18.dp))
                }
            }
        }
    }
}

@Composable
private fun QueueStatusIcon(status: QueuedMessageStatus) {
    val colors = LocalAAColors.current
    val label = stringResource(when (status) {
        QueuedMessageStatus.Queued -> R.string.session_queue_waiting
        QueuedMessageStatus.Sending -> R.string.session_queue_sending
        QueuedMessageStatus.Interrupting -> R.string.session_queue_interrupting
        QueuedMessageStatus.Failed -> R.string.session_queue_failed
    })
    val tint = if (status == QueuedMessageStatus.Failed) colors.errorIcon else colors.muted
    when (status) {
        QueuedMessageStatus.Sending -> CircularProgressIndicator(
            color = tint, strokeWidth = 1.5.dp, modifier = Modifier.size(18.dp).semantics { contentDescription = label },
        )
        QueuedMessageStatus.Interrupting -> Icon(Lucide.Hand, label, tint = tint, modifier = Modifier.size(18.dp))
        else -> Box(Modifier.size(18.dp)) {
            Icon(Lucide.MessageCircle, label, tint = tint, modifier = Modifier.matchParentSize())
            Canvas(Modifier.matchParentSize()) {
                val stroke = 1.3.dp.toPx()
                drawLine(tint, Offset(size.width * 0.33f, size.height * 0.42f), Offset(size.width * 0.67f, size.height * 0.42f), stroke, StrokeCap.Round)
                drawLine(tint, Offset(size.width * 0.33f, size.height * 0.58f), Offset(size.width * 0.54f, size.height * 0.58f), stroke, StrokeCap.Round)
            }
        }
    }
}
