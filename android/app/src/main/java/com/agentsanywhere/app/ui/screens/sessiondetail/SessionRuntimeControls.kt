package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessiondetail.RuntimeCommand
import com.agentsanywhere.app.feature.sessiondetail.RuntimeNotice
import com.agentsanywhere.app.feature.sessiondetail.RuntimeNoticeAction
import com.agentsanywhere.app.feature.sessiondetail.coerceInput
import com.agentsanywhere.app.feature.sessiondetail.inputFields
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.CircleAlert
import com.composables.icons.lucide.CircleCheck
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Info
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.ShieldCheck
import com.composables.icons.lucide.TriangleAlert
import com.composables.icons.lucide.X

@Composable
internal fun RuntimeCommandSuggestions(
    commands: List<RuntimeCommand>,
    query: String,
    loading: Boolean,
    errorMessage: String?,
    onRetry: () -> Unit,
    onSelect: (RuntimeCommand) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAAColors.current
    val matches = remember(commands, query) { commands.filter { it.matches(query) }.take(6) }
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp)
            .background(colors.canvas.copy(alpha = 0.98f), RoundedCornerShape(18.dp))
            .border(1.dp, colors.border, RoundedCornerShape(18.dp))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        when {
            loading -> Text(stringResource(R.string.session_commands_loading), color = colors.muted)
            errorMessage != null -> {
                Text(errorMessage, color = colors.errorText, fontSize = 13.sp)
                TextButton(onClick = onRetry) { Text(stringResource(R.string.common_retry)) }
            }
            matches.isEmpty() -> Text(stringResource(R.string.session_commands_empty), color = colors.muted)
            else -> matches.forEach { command ->
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color.Transparent, RoundedCornerShape(10.dp))
                        .noRippleClickable { onSelect(command) }
                        .padding(horizontal = 10.dp, vertical = 8.dp),
                ) {
                    Text(
                        text = "/${command.id}  ${command.title}",
                        color = colors.ink.copy(alpha = if (command.enabled) 1f else 0.45f),
                        fontWeight = FontWeight.SemiBold,
                    )
                    (command.disabledReason ?: command.description)?.takeIf(String::isNotBlank)?.let {
                        Text(it, color = colors.muted, fontSize = 12.sp)
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun RuntimeNoticeCard(
    notice: RuntimeNotice,
    busy: Boolean,
    actionsDisabled: Boolean,
    errorMessage: String?,
    onRespond: (RuntimeNoticeAction, Map<String, Any?>?) -> Unit,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
    notificationOnly: Boolean = false,
    composerAdjacent: Boolean = false,
) {
    val colors = LocalAAColors.current
    val destructive = notice.severity == "error" || notice.status == "failed"
    val warning = notice.severity == "warning"
    val success = notice.severity == "success"
    val semanticAccent = when {
        destructive -> colors.errorIcon
        warning -> colors.noticeWarning
        success -> colors.noticeSuccess
        else -> colors.muted
    }
    val accent = if (composerAdjacent && !destructive) colors.muted else semanticAccent
    val cardShape = RoundedCornerShape(
        when {
            composerAdjacent -> 22.dp
            compact -> 12.dp
            else -> 16.dp
        },
    )
    var selectedActionId by remember(notice.noticeId) { mutableStateOf<String?>(null) }
    var rawValues by remember(notice.noticeId, selectedActionId) { mutableStateOf(emptyMap<String, String>()) }
    var validationError by remember(notice.noticeId, selectedActionId) { mutableStateOf<String?>(null) }
    val selectedAction = notice.actions.firstOrNull { it.actionId == selectedActionId }
    val fields = selectedAction?.inputFields().orEmpty()
    val disabled = actionsDisabled || busy || notice.status in setOf("response_accepted", "resolving")

    fun submit(action: RuntimeNoticeAction) {
        action.coerceInput(rawValues)
            .onSuccess { input ->
                validationError = null
                onRespond(action, input)
            }
            .onFailure { validationError = it.message }
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(cardShape)
            .background(
                when {
                    composerAdjacent -> colors.raisedSurface
                    destructive -> colors.errorIcon.copy(alpha = 0.06f)
                    warning -> semanticAccent.copy(alpha = 0.05f)
                    success -> semanticAccent.copy(alpha = 0.05f)
                    else -> colors.canvas
                },
            )
            .then(
                if (composerAdjacent) {
                    Modifier
                } else {
                    Modifier.border(
                        1.dp,
                        if (notice.severity == "info") colors.border else semanticAccent.copy(alpha = 0.32f),
                        cardShape,
                    )
                },
            )
            .padding(
                when {
                    composerAdjacent -> 16.dp
                    compact -> 12.dp
                    else -> 14.dp
                },
            ),
        verticalArrangement = Arrangement.spacedBy(if (composerAdjacent) 14.dp else 11.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(9.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Icon(
                imageVector = when {
                    destructive -> Lucide.CircleAlert
                    notificationOnly && warning -> Lucide.TriangleAlert
                    notificationOnly && success -> Lucide.CircleCheck
                    notificationOnly -> Lucide.Info
                    else -> Lucide.ShieldCheck
                },
                contentDescription = null,
                tint = accent,
                modifier = Modifier.size(17.dp),
            )
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(
                    text = notice.title,
                    color = colors.ink,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                notice.message?.takeIf(String::isNotBlank)?.let { message ->
                    Text(text = message, color = colors.muted, fontSize = 13.sp, lineHeight = 18.sp)
                }
            }
        }

        if (!notificationOnly && notice.actions.isNotEmpty()) {
            val orderedActions = notice.actions.sortedBy { action ->
                when (action.actionId) {
                    "reject", "cancel", "dismiss" -> 0
                    "approve_for_session" -> 1
                    "approve" -> 2
                    else -> if (action.style == "primary") 2 else 1
                }
            }
            if (composerAdjacent && orderedActions.size <= 3) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    orderedActions.forEach { action ->
                        RuntimeNoticeActionButton(
                            action = action,
                            busy = busy && selectedActionId == action.actionId,
                            enabled = !disabled,
                            composerAdjacent = true,
                            onClick = {
                                if (action.inputFields().isNotEmpty()) {
                                    selectedActionId = action.actionId
                                    validationError = null
                                } else {
                                    selectedActionId = action.actionId
                                    submit(action)
                                }
                            },
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            } else {
                FlowRow(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    orderedActions.forEach { action ->
                        RuntimeNoticeActionButton(
                            action = action,
                            busy = busy && selectedActionId == action.actionId,
                            enabled = !disabled,
                            composerAdjacent = false,
                            onClick = {
                                if (action.inputFields().isNotEmpty()) {
                                    selectedActionId = action.actionId
                                    validationError = null
                                } else {
                                    selectedActionId = action.actionId
                                    submit(action)
                                }
                            },
                        )
                    }
                }
            }
        }

        if (selectedAction != null && !disabled) {
            fields.forEach { field ->
                OutlinedTextField(
                    value = rawValues[field.key].orEmpty(),
                    onValueChange = { rawValues = rawValues + (field.key to it) },
                    label = { Text(field.label) },
                    singleLine = field.type != "string",
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            validationError?.let { Text(it, color = colors.errorIcon, fontSize = 12.sp) }
            TextButton(onClick = { submit(selectedAction) }) {
                Text(stringResource(R.string.session_notice_submit))
            }
        }

        errorMessage?.let { Text(it, color = colors.errorIcon, fontSize = 12.sp) }
    }
}

@Composable
private fun RuntimeNoticeActionButton(
    action: RuntimeNoticeAction,
    busy: Boolean,
    enabled: Boolean,
    composerAdjacent: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAAColors.current
    val primary = action.style == "primary"
    val danger = action.style == "danger"
    val shape = RoundedCornerShape(if (composerAdjacent) 13.dp else 9.dp)
    val background = when {
        primary -> colors.primaryAction
        composerAdjacent -> colors.secondaryActionSurface
        else -> Color.Transparent
    }
    val contentColor = when {
        primary -> colors.onPrimaryAction
        danger -> colors.errorText
        else -> colors.ink
    }

    TextButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier
            .heightIn(min = if (composerAdjacent) 44.dp else 34.dp)
            .clip(shape)
            .background(background)
            .then(
                if (composerAdjacent || primary) Modifier
                else Modifier.border(1.dp, colors.border, shape),
            ),
    ) {
        if (busy) {
            CircularProgressIndicator(
                modifier = Modifier.size(14.dp),
                strokeWidth = 2.dp,
                color = contentColor,
            )
            Spacer(Modifier.size(6.dp))
        } else if (!composerAdjacent) {
            Icon(
                imageVector = noticeActionIcon(action.actionId),
                contentDescription = null,
                tint = contentColor,
                modifier = Modifier.size(14.dp),
            )
            Spacer(Modifier.size(6.dp))
        }
        Text(
            text = localizedNoticeActionLabel(action),
            color = contentColor,
            fontSize = if (composerAdjacent) 13.sp else 12.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun localizedNoticeActionLabel(action: RuntimeNoticeAction): String = when (action.actionId) {
    "approve" -> stringResource(R.string.session_approval_approve)
    "approve_for_session" -> stringResource(R.string.session_approval_approve_session)
    "reject" -> stringResource(R.string.session_approval_deny)
    "cancel", "dismiss" -> stringResource(R.string.common_cancel)
    else -> action.label.ifBlank { action.actionId }
}

private fun noticeActionIcon(actionId: String): ImageVector = when (actionId) {
    "reject", "cancel", "dismiss" -> Lucide.X
    "approve_for_session" -> Lucide.ShieldCheck
    else -> Lucide.Check
}

@Composable
internal fun BlockingRuntimeNoticeStack(
    notices: List<RuntimeNotice>,
    respondingNoticeIds: Set<String>,
    responseErrors: Map<String, String>,
    canRespond: Boolean,
    onRespond: (RuntimeNotice, RuntimeNoticeAction, Map<String, Any?>?) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (notices.isEmpty()) return
    val colors = LocalAAColors.current
    val active = notices.first()
    val backing = notices.drop(1).take(3).asReversed()
    val maxCardHeight = LocalConfiguration.current.screenHeightDp.dp * 0.38f
    Box(
        modifier = modifier
            .fillMaxWidth()
            .padding(start = 14.dp, end = 14.dp, top = (backing.size * 7).dp, bottom = 4.dp),
    ) {
        backing.forEachIndexed { index, _ ->
            val depth = backing.size - index
            Box(
                modifier = Modifier
                    .matchParentSize()
                    .offset(y = (-depth * 7).dp)
                    .graphicsLayer {
                        scaleX = 1f - depth * 0.014f
                        scaleY = 1f - depth * 0.014f
                        alpha = 1f - depth * 0.16f
                    }
                    .clip(RoundedCornerShape(16.dp))
                    .background(colors.raisedSurface),
            )
        }
        RuntimeNoticeCard(
            notice = active,
            busy = active.noticeId in respondingNoticeIds,
            actionsDisabled = !canRespond || respondingNoticeIds.isNotEmpty(),
            errorMessage = responseErrors[active.noticeId],
            onRespond = { action, input -> onRespond(active, action, input) },
            composerAdjacent = true,
            modifier = Modifier
                .heightIn(max = maxCardHeight)
                .verticalScroll(rememberScrollState()),
        )
    }
}
