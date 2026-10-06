package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessiondetail.SessionInsights
import com.agentsanywhere.app.feature.sessiondetail.formatTokenCount

/**
 * Conversation-total AI-call stats strip pinned above the composer
 * (turns/steps, decode speed, cumulative tokens with cache hit, and context
 * occupancy). Hidden until the runtime reports at least one figure.
 */
@Composable
fun SessionStatsBar(
    insights: SessionInsights?,
    modifier: Modifier = Modifier,
) {
    if (insights == null) return
    val segments = buildList {
        insights.sessionStats?.takeIf { it.turns > 0 }?.let { stats ->
            val speed = stats.decodeTokensPerSecond
            add(
                if (speed != null) {
                    stringResource(R.string.session_stats_turns_speed, stats.turns, stats.steps, speed)
                } else {
                    stringResource(R.string.session_stats_turns, stats.turns, stats.steps)
                },
            )
        }
        insights.tokenUsage?.takeIf { it.totalTokens > 0 }?.let { usage ->
            val cache = usage.cacheHitPercent
            add(
                if (cache != null) {
                    stringResource(
                        R.string.session_stats_tokens_cache,
                        formatTokenCount(usage.totalTokens),
                        cache,
                    )
                } else {
                    stringResource(R.string.session_stats_tokens, formatTokenCount(usage.totalTokens))
                },
            )
        }
        insights.contextPressure?.contextPercent?.let { percent ->
            add(stringResource(R.string.session_stats_context, percent))
        }
    }
    if (segments.isEmpty()) return
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp, vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        segments.forEach { segment ->
            Text(
                text = segment,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.75f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
