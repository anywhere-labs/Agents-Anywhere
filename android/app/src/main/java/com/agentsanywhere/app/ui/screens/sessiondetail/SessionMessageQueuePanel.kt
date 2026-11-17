package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.RemoteSessionQueueItem
import com.agentsanywhere.app.api.RemoteSessionQueueState
import com.agentsanywhere.app.feature.sessiondetail.QueuePause
import com.agentsanywhere.app.feature.sessiondetail.SessionRuntimeStatus
import com.agentsanywhere.app.feature.sessiondetail.editable
import com.agentsanywhere.app.feature.sessiondetail.queuePause
import com.agentsanywhere.app.ui.designsystem.noRippleClickable

private const val COLLAPSED_QUEUE_ITEMS = 2

/** What the user asked the queue to do. */
internal sealed interface QueueAction {
    data class Edit(val messageId: String, val content: String) : QueueAction
    data class Delete(val messageId: String) : QueueAction
    data class Retry(val messageId: String) : QueueAction
    data class SendNow(val messageId: String) : QueueAction
    data object Resume : QueueAction
    data object Clear : QueueAction
}

/** Messages waiting on the Server for this session, shown above the composer. */
@Composable
internal fun SessionMessageQueuePanel(
    queue: RemoteSessionQueueState?,
    runtimeStatus: SessionRuntimeStatus,
    darkMode: Boolean,
    canControl: Boolean,
    canInterrupt: Boolean,
    busyId: String?,
    onAction: (QueueAction) -> Unit,
) {
    val items = queue?.items.orEmpty()
    if (items.isEmpty()) return
    var expanded by remember(queue?.sessionId) { mutableStateOf(false) }
    var editing by remember(queue?.sessionId) { mutableStateOf<Pair<String, String>?>(null) }
    val pause = queuePause(runtimeStatus, queue)
    val shown = if (expanded) items else items.take(COLLAPSED_QUEUE_ITEMS)
    val surface = if (darkMode) Color(0xFF1C1C1F) else Color(0xF2F6F5F2)
    val muted = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF8A8984)
    val text = if (darkMode) Color(0xFFEDEDEF) else Color(0xFF252622)
    val danger = Color(0xFFEF4444)
    val idle = busyId == null

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(surface)
            .padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                stringResource(R.string.session_queue_title, items.size),
                color = text,
                fontSize = 12.sp,
                style = MaterialTheme.typography.labelMedium,
            )
            Spacer(Modifier.weight(1f))
            if (pause == QueuePause.Error && canControl) {
                TextButton(onClick = { onAction(QueueAction.Resume) }, enabled = idle) {
                    Text(stringResource(R.string.session_queue_resume), fontSize = 12.sp)
                }
            }
            if (canControl && items.size > 1) {
                TextButton(onClick = { onAction(QueueAction.Clear) }, enabled = idle) {
                    Text(stringResource(R.string.session_queue_clear), fontSize = 12.sp)
                }
            }
        }
        when (pause) {
            QueuePause.Error -> Text(stringResource(R.string.session_queue_paused_error), color = muted, fontSize = 12.sp)
            QueuePause.Failed -> Text(stringResource(R.string.session_queue_paused_failed), color = danger, fontSize = 12.sp)
            null -> Unit
        }
        shown.forEach { item ->
            QueueRow(
                item = item,
                busy = busyId == item.messageId,
                canControl = canControl,
                canInterrupt = canInterrupt,
                textColor = text,
                muted = muted,
                danger = danger,
                onEdit = { editing = item.messageId to item.content },
                onAction = onAction,
            )
        }
        if (items.size > COLLAPSED_QUEUE_ITEMS) {
            Text(
                if (expanded) stringResource(R.string.session_queue_collapse)
                else stringResource(R.string.session_queue_show_all, items.size),
                color = muted,
                fontSize = 12.sp,
                modifier = Modifier
                    .padding(vertical = 4.dp)
                    .noRippleClickable { expanded = !expanded },
            )
        }
    }

    editing?.let { (messageId, draft) ->
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text(stringResource(R.string.session_queue_edit_title)) },
            text = {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { editing = messageId to it },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        onAction(QueueAction.Edit(messageId, draft.trim()))
                        editing = null
                    },
                    enabled = idle && draft.isNotBlank(),
                ) { Text(stringResource(R.string.session_queue_save)) }
            },
            dismissButton = {
                TextButton(onClick = { editing = null }) { Text(stringResource(R.string.session_queue_cancel)) }
            },
        )
    }
}

@Composable
private fun QueueRow(
    item: RemoteSessionQueueItem,
    busy: Boolean,
    canControl: Boolean,
    canInterrupt: Boolean,
    textColor: Color,
    muted: Color,
    danger: Color,
    onEdit: () -> Unit,
    onAction: (QueueAction) -> Unit,
) {
    val failed = item.status == "failed"
    val editable = canControl && item.editable()
    var menuOpen by remember(item.messageId) { mutableStateOf(false) }
    Box {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 32.dp)
                .then(if (editable && !busy) Modifier.noRippleClickable { menuOpen = true } else Modifier),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                if (failed) "!" else "#${item.position}",
                color = if (failed) danger else muted,
                fontSize = 12.sp,
            )
            Text(
                item.content.ifBlank {
                    if (item.attachmentCount > 0) stringResource(R.string.session_queue_attachments, item.attachmentCount) else ""
                },
                color = if (failed) danger else textColor,
                fontSize = 14.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (busy || item.status == "sending") {
                CircularProgressIndicator(strokeWidth = 1.5.dp, color = muted, modifier = Modifier.size(12.dp))
                Spacer(Modifier.width(2.dp))
            }
            Text(
                stringResource(
                    when {
                        item.status == "sending" -> R.string.session_queue_sending
                        failed -> R.string.session_queue_failed
                        item.interruptRequested -> R.string.session_queue_interrupting
                        else -> R.string.session_queue_waiting
                    },
                ),
                color = if (failed) danger else muted,
                fontSize = 12.sp,
            )
        }
        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            if (failed) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.session_queue_retry)) },
                    onClick = { menuOpen = false; onAction(QueueAction.Retry(item.messageId)) },
                )
            } else if (canInterrupt && !item.interruptRequested) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.session_queue_send_now)) },
                    onClick = { menuOpen = false; onAction(QueueAction.SendNow(item.messageId)) },
                )
            }
            DropdownMenuItem(
                text = { Text(stringResource(R.string.session_queue_edit)) },
                onClick = { menuOpen = false; onEdit() },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.session_queue_delete), color = danger) },
                onClick = { menuOpen = false; onAction(QueueAction.Delete(item.messageId)) },
            )
        }
    }
}
