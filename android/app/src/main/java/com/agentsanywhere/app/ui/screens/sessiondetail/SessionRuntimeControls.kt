package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessiondetail.RuntimeCommand
import com.agentsanywhere.app.feature.sessiondetail.RuntimeInputRequestDraft
import com.agentsanywhere.app.feature.sessiondetail.RuntimeInputRequestForm
import com.agentsanywhere.app.feature.sessiondetail.RuntimeInputRequestQuestion
import com.agentsanywhere.app.feature.sessiondetail.RuntimeNotice
import com.agentsanywhere.app.feature.sessiondetail.RuntimeNoticeAction
import com.agentsanywhere.app.feature.sessiondetail.argumentHint
import com.agentsanywhere.app.feature.sessiondetail.buildPayload
import com.agentsanywhere.app.feature.sessiondetail.coerceInput
import com.agentsanywhere.app.feature.sessiondetail.inputRequestForm
import com.agentsanywhere.app.feature.sessiondetail.inputFields
import com.agentsanywhere.app.feature.sessiondetail.isComplete
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.CircleAlert
import com.composables.icons.lucide.CircleCheck
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.ChevronUp
import com.composables.icons.lucide.Info
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.ShieldCheck
import com.composables.icons.lucide.TriangleAlert
import com.composables.icons.lucide.X
import kotlinx.coroutines.delay

/**
 * Prefix-matched catalog commands for a slash draft. Blocked rows stay visible
 * with their reason so the user learns why a command cannot run right now.
 */
@Composable
internal fun RuntimeCommandSuggestions(
    commands: List<RuntimeCommand>,
    loading: Boolean,
    errorMessage: String?,
    onRetry: (() -> Unit)?,
    blockReason: (RuntimeCommand) -> String?,
    onSelect: (RuntimeCommand) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAAColors.current
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
            loading && commands.isEmpty() -> Text(stringResource(R.string.session_commands_loading), color = colors.muted)
            errorMessage != null && commands.isEmpty() -> {
                Text(errorMessage, color = colors.errorText, fontSize = 13.sp)
                onRetry?.let { TextButton(onClick = it) { Text(stringResource(R.string.common_retry)) } }
            }
            commands.isEmpty() -> Text(stringResource(R.string.session_commands_empty), color = colors.muted)
            else -> commands.forEach { command ->
                val reason = blockReason(command)
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color.Transparent, RoundedCornerShape(10.dp))
                        .noRippleClickable { onSelect(command) }
                        .padding(horizontal = 10.dp, vertical = 8.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = "/${command.id}",
                            color = colors.ink.copy(alpha = if (reason == null) 1f else 0.45f),
                            fontWeight = FontWeight.SemiBold,
                        )
                        command.argumentHint?.takeIf(String::isNotBlank)?.let { hint ->
                            Text(
                                text = " $hint",
                                color = colors.muted,
                                fontSize = 13.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        Spacer(Modifier.size(width = 10.dp, height = 1.dp))
                        Text(
                            text = command.title,
                            color = colors.muted.copy(alpha = if (reason == null) 1f else 0.6f),
                            fontSize = 13.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    (reason ?: command.description)?.takeIf(String::isNotBlank)?.let {
                        Text(
                            it,
                            color = if (reason != null) colors.errorText else colors.muted,
                            fontSize = 12.sp,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
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
    expanded: Boolean = true,
    onExpandedChange: ((Boolean) -> Unit)? = null,
) {
    val colors = LocalAAColors.current
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val inputScrollState = rememberScrollState()
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
    val draftStore = rememberRuntimeNoticeDraftStore()
    val lifecycleOwner = LocalLifecycleOwner.current
    val inputRequestForm = remember(notice.sessionId, notice.noticeId, notice.revision) { notice.inputRequestForm() }
    var noticeDraft by remember(draftStore, notice.sessionId, notice.noticeId, notice.revision) {
        val saved = draftStore.restore(notice.sessionId, notice.noticeId)
        val action = notice.actions.firstOrNull { it.actionId == saved.selectedActionId }
        val fieldKeys = action?.inputFields().orEmpty().map { it.key }.toSet()
        mutableStateOf(saved.copy(
            selectedActionId = action?.actionId,
            rawValues = saved.rawValues.filterKeys { it in fieldKeys },
            answers = inputRequestForm?.questions.orEmpty().associate { question ->
                val answer = saved.answers[question.id] ?: RuntimeInputRequestDraft()
                val optionIds = answer.optionIds.filter { id -> question.options.any { it.id == id } }.distinct()
                val useCustom = question.allowCustom && answer.useCustom
                question.id to answer.copy(
                    optionIds = when {
                        question.multiple -> optionIds
                        useCustom -> emptyList()
                        else -> optionIds.take(1)
                    },
                    customText = if (question.allowCustom) answer.customText else "",
                    useCustom = useCustom,
                )
            },
        ))
    }
    val selectedActionId = noticeDraft.selectedActionId
    val rawValues = noticeDraft.rawValues
    val inputRequestDrafts = noticeDraft.answers
    var validationError by remember(notice.sessionId, notice.noticeId, selectedActionId) { mutableStateOf<String?>(null) }

    fun updateDraft(draft: RuntimeNoticeDraft) {
        if (draft == noticeDraft) return
        noticeDraft = draft
        draftStore.update(notice.sessionId, notice.noticeId, draft)
    }

    LaunchedEffect(draftStore, notice.sessionId, notice.noticeId, noticeDraft) {
        delay(400)
        draftStore.flush(notice.sessionId, notice.noticeId)
    }
    LaunchedEffect(draftStore, notice.sessionId, notice.noticeId, notice.status) {
        if (notice.type == "interaction" && !notice.openInteraction) {
            draftStore.clear(notice.sessionId, notice.noticeId)
        }
    }
    DisposableEffect(lifecycleOwner, draftStore, notice.sessionId, notice.noticeId) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) {
                draftStore.flush(notice.sessionId, notice.noticeId)
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            draftStore.flush(notice.sessionId, notice.noticeId)
        }
    }
    val selectedAction = notice.actions.firstOrNull { it.actionId == selectedActionId }
    val fields = selectedAction
        ?.takeUnless { it.actionId == inputRequestForm?.action?.actionId }
        ?.inputFields()
        .orEmpty()
    val disabled = actionsDisabled || busy || notice.status in setOf("response_accepted", "resolving")
    val orderedActions = notice.actions.sortedBy { action ->
        when (action.actionId) {
            "reject", "cancel", "dismiss" -> 0
            "approve_for_session" -> 1
            "approve" -> 2
            else -> if (action.style == "primary") 2 else 1
        }
    }
    val useHeaderIconActions = composerAdjacent &&
        inputRequestForm == null &&
        orderedActions.isNotEmpty() &&
        orderedActions.size <= 3 &&
        orderedActions.all { it.inputFields().isEmpty() }

    fun submit(action: RuntimeNoticeAction) {
        action.coerceInput(rawValues)
            .onSuccess { input ->
                validationError = null
                onRespond(action, input)
            }
            .onFailure { validationError = it.message }
    }

    fun triggerAction(action: RuntimeNoticeAction) {
        val form = inputRequestForm
        focusManager.clearFocus()
        updateDraft(noticeDraft.copy(
            selectedActionId = action.actionId,
            rawValues = if (selectedActionId == action.actionId) rawValues else emptyMap(),
        ))
        validationError = null
        when {
            form != null && action.actionId == form.action.actionId -> {
                onRespond(action, form.buildPayload(inputRequestDrafts))
            }
            action.inputFields().isNotEmpty() -> Unit
            else -> submit(action)
        }
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
            .then(
                if (inputRequestForm != null) {
                    Modifier.noRippleClickable { focusManager.clearFocus() }
                } else {
                    Modifier
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
        if (onExpandedChange != null) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 32.dp)
                    .noRippleClickable {
                        if (expanded) {
                            focusManager.clearFocus()
                            keyboard?.hide()
                        }
                        onExpandedChange(!expanded)
                    },
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = if (expanded) {
                        stringResource(R.string.session_notice_pending_response)
                    } else {
                        inputRequestForm?.questions?.firstOrNull()?.header?.takeIf(String::isNotBlank)
                            ?: notice.title
                    },
                    modifier = Modifier.weight(1f),
                    color = colors.muted,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = stringResource(
                        if (expanded) R.string.session_notice_collapse else R.string.session_notice_expand,
                    ),
                    color = colors.inkSoft,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                )
                Icon(
                    imageVector = if (expanded) Lucide.ChevronDown else Lucide.ChevronUp,
                    contentDescription = null,
                    tint = colors.inkSoft,
                    modifier = Modifier.size(16.dp),
                )
            }
        }
        // Keep this card mounted so collapsing never discards a selected answer or text draft.
        if (!expanded) return@Column

        if (inputRequestForm == null) {
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
                if (useHeaderIconActions) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        orderedActions.forEach { action ->
                            RuntimeNoticeIconActionButton(
                                action = action,
                                busy = busy && selectedActionId == action.actionId,
                                enabled = !disabled,
                                onClick = { triggerAction(action) },
                            )
                        }
                    }
                }
            }
        } else {
            RuntimeInputRequestFields(
                form = inputRequestForm,
                drafts = inputRequestDrafts,
                disabled = disabled,
                onDraftChange = { questionId, draft ->
                    updateDraft(noticeDraft.copy(answers = inputRequestDrafts + (questionId to draft)))
                },
                modifier = Modifier
                    .weight(1f, fill = false)
                    .verticalScroll(inputScrollState),
            )
        }

        if (!notificationOnly && notice.actions.isNotEmpty() && !useHeaderIconActions) {
            FlowRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(
                    8.dp,
                    if (inputRequestForm != null) Alignment.End else Alignment.CenterHorizontally,
                ),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                orderedActions.forEach { action ->
                    val inputActionIncomplete = inputRequestForm?.let { form ->
                        action.actionId == form.action.actionId && !form.isComplete(inputRequestDrafts)
                    } ?: false
                    RuntimeNoticeActionButton(
                        action = action,
                        busy = busy && selectedActionId == action.actionId,
                        enabled = !disabled && !inputActionIncomplete,
                        composerAdjacent = composerAdjacent,
                        onClick = { triggerAction(action) },
                    )
                }
            }
        }

        if (selectedAction != null && fields.isNotEmpty() && !disabled) {
            fields.forEach { field ->
                OutlinedTextField(
                    value = rawValues[field.key].orEmpty(),
                    onValueChange = { updateDraft(noticeDraft.copy(rawValues = rawValues + (field.key to it))) },
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
private fun RuntimeNoticeIconActionButton(
    action: RuntimeNoticeAction,
    busy: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    val primary = action.style == "primary"
    val contentColor = if (primary) colors.onPrimaryAction else colors.ink
    val buttonAlpha = when {
        busy -> 1f
        enabled -> 1f
        else -> 0.28f
    }
    Box(
        modifier = Modifier
            .size(32.dp)
            .clip(CircleShape)
            .background(if (primary) colors.primaryAction else colors.secondaryActionSurface)
            .graphicsLayer { alpha = buttonAlpha }
            .then(if (enabled) Modifier.noRippleClickable(onClick = onClick) else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        Crossfade(
            targetState = busy,
            animationSpec = tween(durationMillis = 140),
            label = "approval icon loading",
        ) { loading ->
            if (loading) {
                CircularProgressIndicator(
                    modifier = Modifier.size(16.dp),
                    strokeWidth = 1.8.dp,
                    color = contentColor,
                )
            } else {
                Icon(
                    imageVector = noticeActionIcon(action.actionId),
                    contentDescription = localizedNoticeActionLabel(action),
                    tint = contentColor,
                    modifier = Modifier.size(15.dp),
                )
            }
        }
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
    val buttonAlpha = when {
        busy -> 1f
        enabled -> 1f
        else -> 0.28f
    }

    if (composerAdjacent) {
        Box(
            modifier = modifier
                .widthIn(min = 68.dp)
                .height(32.dp)
                .clip(shape)
                .background(background)
                .graphicsLayer { alpha = buttonAlpha }
                .then(if (enabled) Modifier.noRippleClickable(onClick = onClick) else Modifier)
                .padding(horizontal = 14.dp),
            contentAlignment = Alignment.Center,
        ) {
            Crossfade(
                targetState = busy,
                animationSpec = tween(durationMillis = 140),
                label = "approval action loading",
            ) {
                if (it) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(15.dp),
                        strokeWidth = 1.8.dp,
                        color = contentColor,
                    )
                } else {
                    Text(
                        text = localizedNoticeActionLabel(action),
                        color = contentColor,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        return
    }

    TextButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier
            .heightIn(min = 34.dp)
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
        } else {
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
            fontSize = 12.sp,
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
    "submit" -> stringResource(R.string.session_input_request_submit)
    else -> action.label.ifBlank { action.actionId }
}

@Composable
private fun RuntimeInputRequestFields(
    form: RuntimeInputRequestForm,
    drafts: Map<String, RuntimeInputRequestDraft>,
    disabled: Boolean,
    onDraftChange: (String, RuntimeInputRequestDraft) -> Unit,
    modifier: Modifier = Modifier,
) {
    val focusManager = LocalFocusManager.current
    Column(
        modifier = modifier.noRippleClickable { focusManager.clearFocus() },
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        form.questions.forEach { question ->
            RuntimeInputRequestQuestionFields(
                question = question,
                draft = drafts[question.id] ?: RuntimeInputRequestDraft(),
                disabled = disabled,
                onChange = { onDraftChange(question.id, it) },
            )
        }
    }
}

@Composable
private fun RuntimeInputRequestQuestionFields(
    question: RuntimeInputRequestQuestion,
    draft: RuntimeInputRequestDraft,
    disabled: Boolean,
    onChange: (RuntimeInputRequestDraft) -> Unit,
) {
    val colors = LocalAAColors.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        question.header?.let { header ->
            Text(
                text = header,
                color = colors.muted,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
            )
        }
        Text(
            text = question.prompt,
            color = colors.ink,
            fontSize = 14.sp,
            lineHeight = 19.sp,
            fontWeight = FontWeight.Medium,
        )
        question.options.forEach { option ->
            val selected = option.id in draft.optionIds
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(colors.subtle.copy(alpha = if (selected) 1f else 0.68f))
                    .then(
                        if (disabled) Modifier else Modifier.noRippleClickable {
                            val optionIds = if (question.multiple) {
                                if (selected) draft.optionIds - option.id else draft.optionIds + option.id
                            } else {
                                listOf(option.id)
                            }
                            onChange(
                                draft.copy(
                                    optionIds = optionIds,
                                    customText = if (question.multiple) draft.customText else "",
                                    useCustom = if (question.multiple) draft.useCustom else false,
                                ),
                            )
                        },
                    )
                    .padding(horizontal = 11.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.Top,
            ) {
                RuntimeInputRequestSelectionIndicator(
                    selected = selected,
                    multiple = question.multiple,
                )
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(
                        text = option.label,
                        color = colors.ink.copy(alpha = if (disabled) 0.5f else 1f),
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                    )
                    option.description?.let { description ->
                        Text(
                            text = description,
                            color = colors.muted.copy(alpha = if (disabled) 0.5f else 1f),
                            fontSize = 12.sp,
                            lineHeight = 16.sp,
                        )
                    }
                }
            }
        }
        if (question.allowCustom) {
            RuntimeInputRequestCustomAnswer(
                multiple = question.multiple,
                showSelectionIndicator = question.options.isNotEmpty(),
                draft = draft,
                disabled = disabled,
                onChange = onChange,
            )
        }
    }
}

@Composable
private fun RuntimeInputRequestCustomAnswer(
    multiple: Boolean,
    showSelectionIndicator: Boolean,
    draft: RuntimeInputRequestDraft,
    disabled: Boolean,
    onChange: (RuntimeInputRequestDraft) -> Unit,
) {
    val colors = LocalAAColors.current
    fun selectCustom() {
        if (disabled) return
        onChange(
            draft.copy(
                optionIds = if (multiple) draft.optionIds else emptyList(),
                useCustom = true,
            ),
        )
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(colors.subtle.copy(alpha = if (draft.useCustom) 1f else 0.68f))
            .then(if (disabled) Modifier else Modifier.noRippleClickable { selectCustom() })
            .padding(horizontal = 11.dp, vertical = 9.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (showSelectionIndicator) {
            RuntimeInputRequestSelectionIndicator(
                selected = draft.useCustom,
                multiple = multiple,
            )
        }
        BasicTextField(
            value = draft.customText,
            onValueChange = { value ->
                onChange(
                    draft.copy(
                        optionIds = if (multiple) draft.optionIds else emptyList(),
                        customText = value,
                        useCustom = true,
                    ),
                )
            },
            enabled = !disabled,
            singleLine = true,
            textStyle = TextStyle(
                color = colors.ink,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
            ),
            cursorBrush = SolidColor(colors.ink),
            modifier = Modifier
                .weight(1f)
                .onFocusChanged { if (it.isFocused) selectCustom() },
            decorationBox = { innerTextField ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (draft.customText.isEmpty()) {
                        Text(
                            text = stringResource(
                                if (showSelectionIndicator) R.string.session_input_request_other
                                else R.string.session_input_request_reply,
                            ),
                            color = colors.muted,
                            fontSize = 13.sp,
                        )
                    }
                    innerTextField()
                }
            },
        )
    }
}

@Composable
private fun RuntimeInputRequestSelectionIndicator(
    selected: Boolean,
    multiple: Boolean,
) {
    val colors = LocalAAColors.current
    val shape = if (multiple) RoundedCornerShape(6.dp) else CircleShape
    Box(
        modifier = Modifier
            .size(20.dp)
            .clip(shape)
            .background(if (selected) colors.primaryAction else colors.secondaryActionSurface),
        contentAlignment = Alignment.Center,
    ) {
        if (selected) {
            Icon(
                imageVector = Lucide.Check,
                contentDescription = null,
                tint = colors.onPrimaryAction,
                modifier = Modifier.size(13.dp),
            )
        }
    }
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
    var expanded by rememberSaveable(active.noticeId) { mutableStateOf(true) }
    val backing = if (expanded) notices.drop(1).take(3).asReversed() else emptyList()
    val inputRequest = active.inputRequestForm()
    val maxCardHeight = LocalConfiguration.current.screenHeightDp.dp *
        if (inputRequest != null) 0.58f else 0.38f
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
            expanded = expanded,
            onExpandedChange = { expanded = it },
            modifier = Modifier
                .heightIn(max = maxCardHeight)
                .then(
                    if (inputRequest == null) Modifier.verticalScroll(rememberScrollState())
                    else Modifier,
                ),
        )
    }
}
