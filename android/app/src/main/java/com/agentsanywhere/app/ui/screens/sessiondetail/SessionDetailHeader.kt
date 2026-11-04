package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.composables.icons.lucide.ChevronLeft
import com.composables.icons.lucide.Ellipsis
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Monitor
import com.composables.icons.lucide.Pencil

@Composable
internal fun SessionDetailHeader(
    title: String,
    deviceName: String?,
    darkMode: Boolean,
    onBack: () -> Unit,
    onTitleClick: () -> Unit,
    onRename: () -> Unit,
    onMore: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAAColors.current
    val surface = if (darkMode) colors.raisedSurface else Color(0xF2FFFFFF)
    val border = if (darkMode) colors.border else Color(0xFFE8E5DE)
    val text = if (darkMode) Color(0xFFFAFAFA) else Color(0xFF2F302D)
    val iconTint = if (darkMode) Color(0xFFE4E4E7) else Color(0xFF343436)

    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(58.dp)
            .padding(horizontal = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // 1. 左侧圆形返回按钮（对标 Codex 图 2）
        Box(
            modifier = Modifier
                .size(38.dp)
                .clip(CircleShape)
                .background(surface)
                .border(1.dp, border, CircleShape)
                .clickable(onClick = onBack),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Lucide.ChevronLeft,
                contentDescription = stringResource(R.string.common_back),
                tint = iconTint,
                modifier = Modifier.size(20.dp),
            )
        }

        // 2. 中间圆角胶囊容器（主标题 + 💻 设备名称，对标 Codex 图 2）
        Box(
            modifier = Modifier
                .weight(1f)
                .height(44.dp)
                .shadow(12.dp, CircleShape, ambientColor = Color(0x08000000), spotColor = Color(0x08000000))
                .clip(CircleShape)
                .background(surface)
                .border(1.dp, border, CircleShape)
                .clickable(onClick = onTitleClick)
                .padding(horizontal = 12.dp),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    text = title,
                    color = text,
                    fontSize = 13.5.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (!deviceName.isNullOrBlank()) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        Icon(
                            imageVector = Lucide.Monitor,
                            contentDescription = null,
                            tint = colors.muted,
                            modifier = Modifier.size(10.dp),
                        )
                        Text(
                            text = deviceName,
                            color = colors.muted,
                            fontSize = 10.5.sp,
                            fontWeight = FontWeight.Normal,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }

        // 3. 右侧编辑按钮 🖊（对标 Codex 图 2）
        Box(
            modifier = Modifier
                .size(38.dp)
                .clip(CircleShape)
                .background(surface)
                .border(1.dp, border, CircleShape)
                .clickable(onClick = onRename),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Lucide.Pencil,
                contentDescription = stringResource(R.string.home_rename_session),
                tint = iconTint,
                modifier = Modifier.size(15.dp),
            )
        }

        // 4. 右侧更多按钮 ⋮（对标 Codex 图 2）
        Box(
            modifier = Modifier
                .size(38.dp)
                .clip(CircleShape)
                .background(surface)
                .border(1.dp, border, CircleShape)
                .clickable(onClick = onMore),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Lucide.Ellipsis,
                contentDescription = stringResource(R.string.common_more),
                tint = iconTint,
                modifier = Modifier.size(17.dp),
            )
        }
    }
}

@Composable
internal fun HeaderVeil(
    darkMode: Boolean,
    modifier: Modifier = Modifier,
) {
    val base = if (darkMode) Color(0xFF09090B) else Color(0xFFFDFCFB)
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(88.dp)
            .background(
                Brush.verticalGradient(
                    0f to base.copy(alpha = 0.90f),
                    0.46f to base.copy(alpha = 0.72f),
                    1f to base.copy(alpha = 0f),
                ),
            ),
    )
}
