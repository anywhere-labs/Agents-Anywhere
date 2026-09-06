package com.agentsanywhere.app.ui.screens.home

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessions.NewSessionPathEntry
import com.agentsanywhere.app.ui.designsystem.BackGlyph
import com.agentsanywhere.app.ui.designsystem.CheckGlyph
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.Folder
import com.composables.icons.lucide.Lucide

@Composable
internal fun ChoosePathSection(
    currentPath: String,
    currentPathLabel: String,
    parentPath: String?,
    entries: List<NewSessionPathEntry>,
    loading: Boolean,
    error: String?,
    darkMode: Boolean,
    canUseCurrent: Boolean,
    modifier: Modifier,
    onBack: () -> Unit,
    onParent: () -> Unit,
    onUseCurrent: () -> Unit,
    onOpenEntry: (NewSessionPathEntry) -> Unit,
) {
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(32.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.new_session_choose_path),
                color = LocalAAColors.current.ink,
                fontSize = 17.sp,
                fontWeight = FontWeight.ExtraBold,
                lineHeight = 21.sp,
            )
            SmallPill(darkMode = darkMode, onClick = onBack) {
                BackGlyph(color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF555555))
                Text(
                    text = stringResource(R.string.common_back),
                    color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF555555),
                    fontSize = 13.sp,
                    fontWeight = FontWeight.ExtraBold,
                    maxLines = 1,
                )
            }
        }
        CurrentDirectoryBar(
            currentPath = currentPathLabel,
            darkMode = darkMode,
            canGoParent = parentPath != null,
            canUseCurrent = canUseCurrent,
            onParent = onParent,
            onUseCurrent = onUseCurrent,
        )
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
        ) {
            LazyColumn(modifier = Modifier.fillMaxSize()) {
                when {
                    loading -> item {
                        PathMessage(stringResource(R.string.new_session_loading_directory), darkMode)
                    }
                    error != null -> item {
                        PathMessage(error, darkMode)
                    }
                    else -> {
                        if (parentPath != null) {
                            item(key = "$currentPath/..") {
                                PathRow(name = "..", icon = Lucide.Folder, darkMode = darkMode, onClick = onParent)
                            }
                        }
                        if (entries.isEmpty()) {
                            item { PathMessage(stringResource(R.string.new_session_empty_directory), darkMode) }
                        }
                        items(entries, key = { it.path }) { entry ->
                            PathRow(
                                name = entry.name,
                                icon = Lucide.Folder,
                                darkMode = darkMode,
                                onClick = { onOpenEntry(entry) },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CurrentDirectoryBar(
    currentPath: String,
    darkMode: Boolean,
    canGoParent: Boolean,
    canUseCurrent: Boolean,
    onParent: () -> Unit,
    onUseCurrent: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(if (darkMode) LocalAAColors.current.raisedSurface else Color(0xFFF7F7F7))
            .border(1.dp, if (darkMode) Color(0xFF27272A) else Color(0xFFE8E8E8), RoundedCornerShape(18.dp))
            .padding(start = 13.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(
            imageVector = Lucide.Folder,
            contentDescription = null,
            tint = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF555555),
            modifier = Modifier.size(20.dp),
        )
        Text(
            text = currentPath,
            modifier = Modifier.weight(1f),
            color = LocalAAColors.current.ink,
            fontSize = 15.sp,
            fontWeight = FontWeight.ExtraBold,
            lineHeight = 20.sp,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.MiddleEllipsis,
        )
        if (canGoParent) {
            CircleMiniButton(darkMode = darkMode, onClick = onParent) {
                BackGlyph(color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF777777))
            }
        }
        CircleMiniButton(
            darkMode = darkMode,
            selected = !darkMode && canUseCurrent,
            enabled = canUseCurrent,
            onClick = onUseCurrent,
        ) {
            val checkColor = when {
                !canUseCurrent -> if (darkMode) Color(0xFF52525B) else Color(0xFFBDBDBD)
                darkMode -> Color(0xFFA1A1AA)
                else -> Color(0xFF16A34A)
            }
            CheckGlyph(color = checkColor)
        }
    }
}

@Composable
private fun PathRow(
    name: String,
    icon: ImageVector,
    darkMode: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(58.dp)
            .clip(RoundedCornerShape(12.dp))
            .noRippleClickable(onClick = onClick)
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF777777),
            modifier = Modifier.size(20.dp),
        )
        Text(
            text = name,
            color = LocalAAColors.current.ink,
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
            lineHeight = 20.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Icon(
            imageVector = Lucide.ChevronRight,
            contentDescription = null,
            tint = if (darkMode) Color(0xFF71717A) else Color(0xFFA8A6A0),
            modifier = Modifier.size(20.dp),
        )
    }
}

@Composable
internal fun PathMessage(message: String, darkMode: Boolean) {
    Text(
        text = message,
        color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF777777),
        fontSize = 14.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(top = 18.dp, start = 4.dp),
    )
}
