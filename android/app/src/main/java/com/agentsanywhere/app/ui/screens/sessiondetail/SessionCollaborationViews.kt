package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessiondetail.CollabTool
import com.agentsanywhere.app.feature.sessiondetail.TimelineCollabAuthor
import com.agentsanywhere.app.feature.sessiondetail.TimelineMessage
import com.agentsanywhere.app.feature.sessions.SessionCollabBadge
import com.agentsanywhere.app.feature.sessions.SessionCollabBadgeKind
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SupervisionState
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.Bot
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.ExternalLink
import com.composables.icons.lucide.Eye
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.TriangleAlert

/** Resolves related sessions for timeline rows; [find] returns null for sessions outside the loaded lists. */
internal class TimelineSessionLinks(
    val find: (String) -> AgentSession?,
    val open: (AgentSession) -> Unit,
)

internal val LocalTimelineSessionLinks = compositionLocalOf {
    TimelineSessionLinks(find = { null }, open = {})
}

@Composable
internal fun SessionCollabBadgeRow(
    badges: List<SessionCollabBadge>,
    onOpenSession: (AgentSession) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (badges.isEmpty()) return
    Row(
        modifier = modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 18.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        badges.forEach { badge ->
            val title = badge.title?.takeIf(String::isNotBlank) ?: stringResource(R.string.collab_unknown_session)
            val label = when (badge.kind) {
                SessionCollabBadgeKind.CreatedBy -> stringResource(R.string.collab_created_by, title)
                SessionCollabBadgeKind.SupervisedBy -> when (badge.state) {
                    SupervisionState.Paused -> stringResource(R.string.collab_supervised_by_paused, title)
                    SupervisionState.Ended -> stringResource(R.string.collab_supervised_by_ended, title)
                    else -> stringResource(R.string.collab_supervised_by, title)
                }
            }
            CollabChip(
                icon = if (badge.kind == SessionCollabBadgeKind.CreatedBy) Lucide.Bot else Lucide.Eye,
                label = label,
                dimmed = badge.state == SupervisionState.Ended,
                onClick = badge.session?.let { session -> { onOpenSession(session) } },
            )
        }
    }
}

@Composable
private fun CollabChip(
    icon: ImageVector,
    label: String,
    dimmed: Boolean,
    onClick: (() -> Unit)?,
) {
    val colors = LocalAAColors.current
    val tint = if (dimmed) colors.faint else colors.muted
    Row(
        modifier = Modifier
            .clip(CircleShape)
            .background(colors.raisedSurface)
            .border(1.dp, colors.border, CircleShape)
            .then(if (onClick != null) Modifier.noRippleClickable(onClick = onClick) else Modifier)
            .padding(horizontal = 10.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(imageVector = icon, contentDescription = null, tint = tint, modifier = Modifier.size(12.dp))
        Text(
            text = label,
            color = if (dimmed) colors.faint else colors.inkSoft,
            fontSize = 11.5.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** 「由 X 的 Agent 发送」 above a user bubble the Agent of another session sent. */
@Composable
internal fun AgentSentLabel(author: TimelineCollabAuthor, modifier: Modifier = Modifier) {
    val colors = LocalAAColors.current
    val links = LocalTimelineSessionLinks.current
    val sender = author.sessionId?.let(links.find)
    val title = sender?.title?.takeIf(String::isNotBlank) ?: stringResource(R.string.collab_unknown_session)
    Row(
        modifier = modifier
            .padding(horizontal = 4.dp)
            .then(if (sender != null) Modifier.noRippleClickable { links.open(sender) } else Modifier),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(imageVector = Lucide.Bot, contentDescription = null, tint = colors.faint, modifier = Modifier.size(12.dp))
        Text(
            text = stringResource(R.string.collab_agent_sent_by, title),
            color = if (sender != null) colors.muted else colors.faint,
            fontSize = 11.5.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** A supervision digest: a collapsible card instead of the user's own bubble. */
@Composable
internal fun SupervisionNoticeCard(message: TimelineMessage) {
    val colors = LocalAAColors.current
    val reading = checkNotNull(LocalTimelineReading.current)
    val expanded = reading.expanded[message.id] ?: false
    val shape = RoundedCornerShape(14.dp)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(colors.sessionTimelineActivitySurface)
            .border(1.dp, colors.border, shape)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .readingRegion("header:${message.id}")
                .noRippleClickable { reading.toggle(message.id, "header:${message.id}") },
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(imageVector = Lucide.Eye, contentDescription = null, tint = colors.muted, modifier = Modifier.size(14.dp))
            Text(
                text = stringResource(R.string.collab_supervision_notice),
                color = colors.inkSoft,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
            )
            if (!expanded) {
                Text(
                    text = message.text.lineSequence().firstOrNull { it.isNotBlank() }.orEmpty(),
                    modifier = Modifier.weight(1f),
                    color = colors.muted,
                    fontSize = 12.5.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            } else {
                Spacer(Modifier.weight(1f))
            }
            Icon(
                imageVector = if (expanded) Lucide.ChevronDown else Lucide.ChevronRight,
                contentDescription = null,
                tint = colors.faint,
                modifier = Modifier.size(14.dp),
            )
        }
        if (expanded) {
            Text(text = message.text, color = colors.inkSoft, fontSize = 13.5.sp, lineHeight = 20.sp)
        }
    }
}

/** An Agent hands a decision to the user: highlighted, with a link to the asking session. */
@Composable
internal fun EscalationCard(message: TimelineMessage) {
    val escalation = message.escalation ?: return
    val colors = LocalAAColors.current
    val links = LocalTimelineSessionLinks.current
    val from = escalation.fromSessionId?.let(links.find)
    val shape = RoundedCornerShape(14.dp)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(colors.noticeWarning.copy(alpha = if (colors.isDark) 0.14f else 0.08f))
            .border(1.dp, colors.noticeWarning.copy(alpha = 0.55f), shape)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(
                imageVector = Lucide.TriangleAlert,
                contentDescription = null,
                tint = colors.noticeWarning,
                modifier = Modifier.size(14.dp),
            )
            Text(
                text = stringResource(R.string.collab_escalation_title),
                color = colors.noticeWarning,
                fontSize = 12.5.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
        Text(text = escalation.question, color = colors.ink, fontSize = 14.5.sp, fontWeight = FontWeight.Medium, lineHeight = 21.sp)
        escalation.context?.let { context ->
            Text(text = context, color = colors.muted, fontSize = 13.sp, lineHeight = 19.sp)
        }
        if (from != null) {
            Text(
                text = stringResource(R.string.collab_escalation_from, from.title),
                modifier = Modifier.noRippleClickable { links.open(from) },
                color = colors.inkSoft,
                fontSize = 12.5.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** A collaboration tool call: its Chinese label and, for a known target session, an 「打开会话」 action. */
@Composable
internal fun CollabToolRow(message: TimelineMessage) {
    val collabTool = message.collabTool ?: return
    val colors = LocalAAColors.current
    val links = LocalTimelineSessionLinks.current
    val target = collabTool.sessionId?.let(links.find)
    val failed = message.status in setOf("failed", "cancelled", "interrupted")
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Lucide.Bot,
            contentDescription = null,
            tint = if (failed) colors.errorIcon else colors.muted,
            modifier = Modifier.size(16.dp),
        )
        Text(
            text = collabToolLabel(collabTool.tool) ?: collabTool.rawTool,
            color = if (failed) colors.errorIcon else colors.muted,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
        Text(
            text = target?.title ?: message.subtitle,
            modifier = Modifier.weight(1f, fill = false),
            color = colors.faint,
            fontSize = 12.5.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (target != null) {
            Row(
                modifier = Modifier.noRippleClickable { links.open(target) },
                horizontalArrangement = Arrangement.spacedBy(3.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = stringResource(R.string.collab_open_session),
                    color = colors.inkSoft,
                    fontSize = 12.5.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                )
                Icon(
                    imageVector = Lucide.ExternalLink,
                    contentDescription = null,
                    tint = colors.inkSoft,
                    modifier = Modifier.size(12.dp),
                )
            }
        }
    }
}

@Composable
internal fun collabToolLabel(tool: CollabTool?): String? = when (tool) {
    CollabTool.Spawn -> stringResource(R.string.collab_tool_spawn)
    CollabTool.Send -> stringResource(R.string.collab_tool_send)
    CollabTool.Steer -> stringResource(R.string.collab_tool_steer)
    CollabTool.Interrupt -> stringResource(R.string.collab_tool_interrupt)
    CollabTool.Status -> stringResource(R.string.collab_tool_status)
    CollabTool.Read -> stringResource(R.string.collab_tool_read)
    CollabTool.Wait -> stringResource(R.string.collab_tool_wait)
    CollabTool.Respond -> stringResource(R.string.collab_tool_respond)
    CollabTool.PlanReview -> stringResource(R.string.collab_tool_plan_review)
    CollabTool.Supervise -> stringResource(R.string.collab_tool_supervise)
    CollabTool.Unsupervise -> stringResource(R.string.collab_tool_unsupervise)
    CollabTool.Escalate -> stringResource(R.string.collab_tool_escalate)
    CollabTool.Close -> stringResource(R.string.collab_tool_close)
    null -> null
}
