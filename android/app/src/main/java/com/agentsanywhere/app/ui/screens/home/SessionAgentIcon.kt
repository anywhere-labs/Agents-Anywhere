package com.agentsanywhere.app.ui.screens.home

import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.composables.icons.lucide.Bot
import com.composables.icons.lucide.Lucide

@Composable
internal fun SessionAgentIcon(
    runtime: String,
    runtimeType: String?,
    modifier: Modifier = Modifier,
) {
    // Match the Web sidebar's runtime aliases, including custom runtime instances.
    val type = runtimeType?.trim().orEmpty().ifBlank { runtime }
        .lowercase().filterNot { it.isWhitespace() || it == '_' || it == '-' }
    val drawable = when (type) {
        "codex" -> R.drawable.ic_session_agent_codex
        "claude", "claudecode" -> R.drawable.ic_session_agent_claude
        "dsh", "deepseek", "deepseekharness" -> R.drawable.ic_session_agent_deepseek
        else -> null
    }
    val label = when (drawable) {
        R.drawable.ic_session_agent_codex -> "Codex"
        R.drawable.ic_session_agent_claude -> "Claude Code"
        R.drawable.ic_session_agent_deepseek -> "DeepSeek Harness"
        else -> runtime
    }
    if (drawable != null) {
        Icon(
            painter = painterResource(drawable),
            contentDescription = label,
            tint = LocalAAColors.current.faint,
            modifier = modifier.size(16.dp),
        )
    } else {
        Icon(
            imageVector = Lucide.Bot,
            contentDescription = label,
            tint = LocalAAColors.current.faint,
            modifier = modifier.size(16.dp),
        )
    }
}
