package com.agentsanywhere.app.ui.screens.home

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.ui.designsystem.BackGlyph
import com.agentsanywhere.app.ui.designsystem.CheckGlyph
import com.agentsanywhere.app.ui.designsystem.ForwardGlyph
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.ChevronDown
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.ChevronUp
import com.composables.icons.lucide.Folder
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Plus
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
internal fun ProjectSection(
    selectedTitle: String,
    selectedDetail: String,
    projects: List<AgentProject>,
    selectedProjectId: String?,
    expanded: Boolean,
    darkMode: Boolean,
    modifier: Modifier,
    onCreateProject: () -> Unit,
    onToggleExpanded: () -> Unit,
    onSelectProject: (AgentProject) -> Unit,
) {
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(32.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.new_session_workspace),
                color = LocalAAColors.current.ink,
                fontSize = 17.sp,
                fontWeight = FontWeight.ExtraBold,
                lineHeight = 21.sp,
            )
            SmallPill(darkMode = darkMode, onClick = onCreateProject) {
                Icon(
                    imageVector = Lucide.Plus,
                    contentDescription = null,
                    tint = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF555555),
                    modifier = Modifier.size(15.dp),
                )
                Text(
                    text = stringResource(R.string.new_session_create_project),
                    color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF555555),
                    fontSize = 13.sp,
                    fontWeight = FontWeight.ExtraBold,
                    maxLines = 1,
                )
            }
        }
        WorkspaceTrigger(
            title = selectedTitle,
            detail = selectedDetail,
            expanded = expanded,
            darkMode = darkMode,
            onToggleExpanded = { if (projects.isNotEmpty()) onToggleExpanded() },
        )
        if (expanded) {
            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
            ) {
                if (projects.isEmpty()) {
                    item {
                        PathMessage(
                            message = stringResource(R.string.new_session_no_projects),
                            darkMode = darkMode,
                        )
                    }
                }
                items(projects, key = { it.id }) { project ->
                    ProjectRow(
                        title = project.name,
                        detail = project.workspacePath,
                        selected = project.id == selectedProjectId,
                        darkMode = darkMode,
                        onClick = { onSelectProject(project) },
                    )
                }
            }
        }
    }
}

@Composable
private fun WorkspaceTrigger(
    title: String,
    detail: String,
    expanded: Boolean,
    darkMode: Boolean,
    onToggleExpanded: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(if (darkMode) LocalAAColors.current.raisedSurface else Color(0xFFF7F7F7))
            .border(1.dp, if (darkMode) Color(0xFF27272A) else Color(0xFFE8E8E8), RoundedCornerShape(18.dp))
            .padding(horizontal = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(
            imageVector = Lucide.Folder,
            contentDescription = null,
            tint = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF555555),
            modifier = Modifier.size(20.dp),
        )
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = title,
                color = LocalAAColors.current.ink,
                fontSize = 16.sp,
                fontWeight = FontWeight.ExtraBold,
                lineHeight = 20.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = detail,
                color = if (darkMode) Color(0xFF71717A) else Color(0xFF8A8A8A),
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 16.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Box(
            modifier = Modifier
                .size(36.dp)
                .clip(CircleShape)
                .background(if (darkMode) Color.White.copy(alpha = 0.04f) else Color.Black.copy(alpha = 0.04f))
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClick = onToggleExpanded,
                ),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = if (expanded) Lucide.ChevronUp else Lucide.ChevronDown,
                contentDescription = null,
                tint = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF555555),
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

@Composable
private fun ProjectRow(
    title: String,
    detail: String,
    selected: Boolean,
    darkMode: Boolean,
    onClick: () -> Unit,
) {
    val feedbackScope = rememberCoroutineScope()
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    var flash by remember { mutableStateOf(false) }
    val active = pressed || flash
    val rowShape = RoundedCornerShape(16.dp)
    val pressedSurface = if (darkMode) LocalAAColors.current.subtle else Color(0xFFEDEBE6)
    val shadowColor = if (darkMode) Color(0x77000000) else Color(0x30000000)
    val elevation by animateDpAsState(
        targetValue = if (active) 14.dp else 0.dp,
        label = "new-session-workspace-row-elevation",
    )
    val surfaceAlpha by animateFloatAsState(
        targetValue = if (active) 1f else 0f,
        label = "new-session-workspace-row-surface-alpha",
    )
    val titleColor = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF4A4A4A)
    val detailColor = if (darkMode) Color(0xFF71717A) else Color(0xFF888888)
    val iconColor = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF777777)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(58.dp)
            .shadow(
                elevation = elevation,
                shape = rowShape,
                clip = false,
                ambientColor = shadowColor,
                spotColor = shadowColor,
            )
            .clip(rowShape)
            .background(pressedSurface.copy(alpha = surfaceAlpha))
            .clickable(
                interactionSource = interactionSource,
                indication = null,
            ) {
                flash = true
                feedbackScope.launch {
                    delay(160)
                    onClick()
                    flash = false
                }
            }
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(
            imageVector = Lucide.Folder,
            contentDescription = null,
            tint = iconColor,
            modifier = Modifier.size(20.dp),
        )
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = title,
                color = titleColor,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 20.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = detail,
                color = detailColor,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 16.sp,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.StartEllipsis,
            )
        }
        if (selected) {
            CheckGlyph(color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF16A34A))
        } else {
            Icon(
                imageVector = Lucide.ChevronRight,
                contentDescription = null,
                tint = if (darkMode) Color(0xFF71717A) else Color(0xFFA8A6A0),
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

@Composable
internal fun CreateProjectSection(
    name: String,
    workspacePath: String,
    canBrowse: Boolean,
    canCreate: Boolean,
    creating: Boolean,
    error: String?,
    darkMode: Boolean,
    modifier: Modifier,
    onNameChange: (String) -> Unit,
    onChooseDirectory: () -> Unit,
    onCancel: () -> Unit,
    onCreate: () -> Unit,
) {
    val colors = LocalAAColors.current
    Column(
        modifier = modifier
            .fillMaxWidth()
            .windowInsetsPadding(WindowInsets.navigationBars),
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
                text = stringResource(R.string.new_session_create_project),
                color = colors.ink,
                fontSize = 17.sp,
                fontWeight = FontWeight.ExtraBold,
                lineHeight = 21.sp,
            )
            SmallPill(darkMode = darkMode, onClick = onCancel) {
                BackGlyph(color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF555555))
                Text(
                    text = stringResource(R.string.common_cancel),
                    color = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF555555),
                    fontSize = 13.sp,
                    fontWeight = FontWeight.ExtraBold,
                )
            }
        }
        Text(
            text = stringResource(R.string.new_session_project_name),
            color = colors.inkSoft,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(start = 2.dp),
        )
        BasicTextField(
            value = name,
            onValueChange = onNameChange,
            enabled = !creating,
            singleLine = true,
            modifier = Modifier
                .fillMaxWidth()
                .height(54.dp)
                .clip(RoundedCornerShape(18.dp))
                .background(colors.raisedSurface)
                .border(1.dp, colors.border, RoundedCornerShape(18.dp))
                .padding(horizontal = 16.dp),
            textStyle = TextStyle(
                color = colors.ink,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                fontFamily = FontFamily.SansSerif,
            ),
            cursorBrush = SolidColor(colors.ink),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { if (canCreate) onCreate() }),
            decorationBox = { inner ->
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    if (name.isBlank()) {
                        Text(
                            text = stringResource(R.string.new_session_project_name_placeholder),
                            color = colors.faint,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                    inner()
                }
            },
        )
        Text(
            text = stringResource(R.string.new_session_project_directory),
            color = colors.inkSoft,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(start = 2.dp),
        )
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp)
                .clip(RoundedCornerShape(18.dp))
                .background(colors.raisedSurface)
                .border(1.dp, colors.border, RoundedCornerShape(18.dp))
                .then(if (canBrowse) Modifier.noRippleClickable(onClick = onChooseDirectory) else Modifier)
                .padding(horizontal = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Lucide.Folder,
                contentDescription = null,
                tint = colors.inkSoft.copy(alpha = if (canBrowse) 1f else 0.45f),
                modifier = Modifier.size(20.dp),
            )
            Text(
                text = workspacePath.ifBlank { stringResource(R.string.new_session_choose_directory) },
                color = colors.ink.copy(alpha = if (canBrowse) 1f else 0.45f),
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
                modifier = Modifier.weight(1f),
            )
            ForwardGlyph(color = colors.muted.copy(alpha = if (canBrowse) 1f else 0.45f))
        }
        error?.let { message ->
            Text(
                text = message,
                color = colors.errorText,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 17.sp,
                modifier = Modifier.padding(horizontal = 2.dp),
            )
        }
        Spacer(Modifier.weight(1f))
        StartChatButton(
            label = if (creating) {
                stringResource(R.string.new_session_project_creating)
            } else {
                stringResource(R.string.new_session_create_project)
            },
            enabled = canCreate,
            onClick = onCreate,
        )
    }
}
