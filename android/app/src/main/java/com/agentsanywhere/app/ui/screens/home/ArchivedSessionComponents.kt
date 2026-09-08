/* Hallmark · pre-emit critique: P4 H4 E4 S4 R5 V3 · native AA theme */
package com.agentsanywhere.app.ui.screens.home

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.ui.designsystem.BackIconButton
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.composables.icons.lucide.*

@Composable
internal fun archiveSecondaryInk(): Color {
    val colors = LocalAAColors.current
    return if (colors.isDark) colors.muted
    else colors.inkSoft.copy(alpha = 0.8f).compositeOver(colors.raisedSurface)
}

@Composable
internal fun ArchivedPageHeader(
    onBack: () -> Unit,
) {
    val colors = LocalAAColors.current
    Row(
        modifier = Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 18.dp).height(64.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BackIconButton(onClick = onBack)
        Text(
            stringResource(R.string.profile_archived_sessions),
            modifier = Modifier.weight(1f).padding(horizontal = 12.dp).semantics { heading() },
            color = colors.ink,
            fontSize = 17.sp,
            lineHeight = 22.sp,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.width(40.dp))
    }
}

@Composable
internal fun ArchivedProjectHeader(
    project: AgentProject?,
    restoring: Boolean,
    enabled: Boolean,
    onRestore: () -> Unit,
) {
    val colors = LocalAAColors.current
    val name = project?.name ?: stringResource(R.string.archived_unknown_project)
    Column(
        modifier = Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 12.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(Lucide.FolderOpen, null, tint = archiveSecondaryInk(), modifier = Modifier.size(20.dp))
            Text(
                name,
                modifier = Modifier.weight(1f).semantics { heading() },
                color = colors.ink,
                fontSize = 15.sp,
                lineHeight = 20.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (project != null) ArchiveActionButton(
                label = stringResource(R.string.archived_restore_project),
                busy = restoring,
                enabled = enabled,
                filled = false,
                description = stringResource(R.string.archive_restore_project_description, name),
                onClick = onRestore,
            )
        }
        project?.workspacePath?.takeIf { it.isNotBlank() }?.let { path ->
            Text(
                path,
                modifier = Modifier.fillMaxWidth().padding(start = 28.dp, end = 12.dp),
                color = archiveSecondaryInk(),
                fontSize = 11.sp,
                lineHeight = 16.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
internal fun ArchivedSessionRow(
    session: AgentSession,
    archivedTime: String,
    first: Boolean,
    last: Boolean,
    restoring: Boolean,
    enabled: Boolean,
    onRestore: () -> Unit,
) {
    val colors = LocalAAColors.current
    val shape = RoundedCornerShape(
        topStart = if (first) 18.dp else 0.dp,
        topEnd = if (first) 18.dp else 0.dp,
        bottomStart = if (last) 18.dp else 0.dp,
        bottomEnd = if (last) 18.dp else 0.dp,
    )
    Column(Modifier.fillMaxWidth().clip(shape).background(colors.raisedSurface)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(session.title, color = colors.ink, fontSize = 15.sp, lineHeight = 21.sp,
                    fontWeight = FontWeight.Medium, maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis)
                Text(stringResource(R.string.archive_archived_at, archivedTime), color = archiveSecondaryInk(),
                    fontSize = 11.sp, lineHeight = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            ArchiveActionButton(
                label = stringResource(R.string.archived_restore),
                busy = restoring,
                enabled = enabled,
                icon = Lucide.ArchiveRestore,
                description = stringResource(R.string.archive_restore_session_description, session.title),
                onClick = onRestore,
            )
        }
        if (!last) HorizontalDivider(
            modifier = Modifier.padding(horizontal = 16.dp),
            color = colors.ink.copy(alpha = 0.07f),
        )
    }
}

@Composable
internal fun ArchiveActionButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    busy: Boolean = false,
    busyLabel: String? = null,
    enabled: Boolean = true,
    filled: Boolean = true,
    icon: ImageVector? = null,
    description: String? = null,
) {
    val colors = LocalAAColors.current
    val surface = if (filled) colors.subtle else Color.Transparent
    TextButton(
        onClick = onClick,
        enabled = enabled && !busy,
        shape = RoundedCornerShape(12.dp),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
        modifier = modifier.heightIn(min = 44.dp).semantics {
            if (description != null) contentDescription = description
        },
        colors = ButtonDefaults.textButtonColors(
            containerColor = surface,
            contentColor = colors.inkSoft,
            disabledContainerColor = surface,
            disabledContentColor = if (busy) archiveSecondaryInk() else colors.inkSoft.copy(alpha = 0.4f),
        ),
    ) {
        if (busy) {
            CircularProgressIndicator(Modifier.size(15.dp), color = archiveSecondaryInk(), strokeWidth = 1.5.dp)
            Spacer(Modifier.width(6.dp))
        } else if (icon != null) {
            Icon(icon, null, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
        }
        Text(if (busy) busyLabel ?: stringResource(R.string.archived_restoring) else label, fontSize = 12.sp,
            fontWeight = FontWeight.Medium, maxLines = 1)
    }
}

@Composable
internal fun ArchivedStatusPanel(
    title: String,
    description: String? = null,
    icon: ImageVector = Lucide.Archive,
    showEmptyIllustration: Boolean = false,
    loading: Boolean = false,
    actionLabel: String? = null,
    actionLoading: Boolean = false,
    onAction: () -> Unit = {},
) {
    val colors = LocalAAColors.current
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 40.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (showEmptyIllustration) {
            Image(
                painter = painterResource(if (colors.isDark) R.drawable.ic_archive_empty_dark else R.drawable.ic_archive_empty_light),
                contentDescription = null,
                modifier = Modifier.size(128.dp),
            )
        } else {
            Box(
                modifier = Modifier.size(80.dp).clip(RoundedCornerShape(26.dp)).background(colors.raisedSurface),
                contentAlignment = Alignment.Center,
            ) {
                if (loading) CircularProgressIndicator(Modifier.size(26.dp), color = colors.inkSoft, strokeWidth = 2.dp)
                else Icon(icon, null, tint = archiveSecondaryInk(), modifier = Modifier.size(32.dp))
            }
        }
        Spacer(Modifier.height(24.dp))
        Text(title, color = colors.inkSoft, fontSize = 16.sp, fontWeight = FontWeight.SemiBold,
            lineHeight = 23.sp, textAlign = TextAlign.Center)
        if (description != null) Text(description, modifier = Modifier.padding(top = 10.dp).widthIn(max = 260.dp),
            color = archiveSecondaryInk(), fontSize = 13.sp, lineHeight = 20.sp, textAlign = TextAlign.Center)
        if (actionLabel != null) {
            Spacer(Modifier.height(24.dp))
            ArchiveActionButton(label = actionLabel, busy = actionLoading,
                busyLabel = stringResource(R.string.archived_loading_more), onClick = onAction)
        }
    }
}

@Composable
internal fun ArchivedListFooter(failed: Boolean, loading: Boolean, enabled: Boolean, onLoadMore: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(top = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (failed) Text(stringResource(R.string.archive_more_failed), color = archiveSecondaryInk(), fontSize = 13.sp)
        ArchiveActionButton(
            label = stringResource(if (failed) R.string.archived_retry else R.string.archived_load_more),
            busy = loading,
            busyLabel = stringResource(R.string.archived_loading_more),
            enabled = enabled,
            filled = false,
            icon = if (failed) Lucide.RefreshCw else Lucide.ChevronDown,
            onClick = onLoadMore,
        )
    }
}
