package com.agentsanywhere.app.ui.screens.home

import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.feature.sessions.listIndicator
import com.agentsanywhere.app.ui.designsystem.LocalAAColors

@Composable
internal fun HomeProjectSessionRow(
    session: AgentSession,
    inset: Boolean = true,
    onClick: () -> Unit,
    onLongPress: (Rect) -> Unit,
) {
    val haptic = LocalHapticFeedback.current
    var bounds by remember { mutableStateOf(Rect.Zero) }
    Row(
        modifier = Modifier.fillMaxWidth().height(44.dp)
            .onGloballyPositioned { bounds = it.boundsInRoot() }
            .pointerInput(onClick, onLongPress, bounds) {
                detectTapGestures(
                    onTap = { onClick() },
                    onLongPress = {
                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                        onLongPress(bounds)
                    },
                )
            }.padding(start = if (inset) 34.dp else 0.dp, end = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = session.title,
            modifier = Modifier.weight(1f),
            color = LocalAAColors.current.inkSoft,
            fontSize = 15.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        SessionStatusIndicator(session.listIndicator())
    }
}
