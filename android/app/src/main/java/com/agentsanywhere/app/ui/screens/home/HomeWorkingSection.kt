package com.agentsanywhere.app.ui.screens.home

import androidx.compose.animation.core.spring
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessions.listIndicator
import com.agentsanywhere.app.feature.sessions.sessionIsWorking
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus
import com.agentsanywhere.app.ui.designsystem.LocalAAColors

/** Sessions that currently occupy a device Agent, grouped by device then id. */
internal fun List<AgentSession>.workingSessions(): List<AgentSession> =
    filter { !it.archived && sessionIsWorking(it) }
        .sortedWith(compareBy({ it.deviceName.lowercase() }, { it.id }))

internal fun SessionStatus.workingStatusLabel(): Int = when (this) {
    SessionStatus.Running -> R.string.home_working_status_running
    SessionStatus.Waiting -> R.string.home_working_status_waiting
    SessionStatus.Pending -> R.string.home_working_status_pending
    SessionStatus.Stopping -> R.string.home_working_status_stopping
    SessionStatus.WaitingApproval -> R.string.home_working_status_waiting_approval
    SessionStatus.Blocked -> R.string.home_working_status_blocked
    else -> R.string.home_working_status_running
}

/**
 * The "in progress" board: every session a device Agent is working on right
 * now, one row per session with `device · status` so the work state of each
 * device is readable at a glance. Rows use `animateItem`, so reorders glide
 * instead of jumping.
 */
internal fun LazyListScope.workingSection(
    sessions: List<AgentSession>,
    onOpenSession: (AgentSession) -> Unit,
    onSessionLongPress: (AgentSession, Rect) -> Unit,
) {
    item("working-title") {
        HomeListSectionHeader(
            label = stringResource(R.string.home_section_working),
            expanded = true,
            onClick = {},
        )
    }
    if (sessions.isEmpty()) {
        item("working-empty") { SectionEmptyText(stringResource(R.string.home_working_empty)) }
    } else {
        items(sessions, key = { "working-${it.id}" }) { session ->
            WorkingSessionRow(
                session = session,
                modifier = Modifier.animateItem(
                    placementSpec = spring(stiffness = 700f),
                    fadeOutSpec = null,
                    fadeInSpec = null,
                ),
                onClick = { onOpenSession(session) },
                onLongPress = { bounds -> onSessionLongPress(session, bounds) },
            )
        }
    }
}

@Composable
private fun WorkingSessionRow(
    session: AgentSession,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
    onLongPress: (Rect) -> Unit,
) {
    val haptic = LocalHapticFeedback.current
    val colors = LocalAAColors.current
    var bounds by remember { mutableStateOf(Rect.Zero) }
    Row(
        modifier = modifier
            .fillMaxWidth()
            .onGloballyPositioned { bounds = it.boundsInRoot() }
            .pointerInput(onClick, onLongPress, bounds) {
                detectTapGestures(
                    onTap = { onClick() },
                    onLongPress = {
                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                        onLongPress(bounds)
                    },
                )
            }
            .padding(horizontal = 18.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SessionAgentIcon(runtime = session.runtime, runtimeType = session.runtimeType)
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = session.title,
                color = colors.inkSoft,
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = listOf(session.deviceName, stringResource(session.status.workingStatusLabel()))
                    .filter(String::isNotBlank)
                    .joinToString(" · "),
                color = colors.inkSoft.copy(alpha = 0.62f),
                fontSize = 12.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        SessionStatusIndicator(session.listIndicator())
    }
}
