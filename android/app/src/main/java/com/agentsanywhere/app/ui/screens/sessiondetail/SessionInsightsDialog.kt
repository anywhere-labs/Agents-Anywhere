package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessiondetail.SessionInsights
import com.agentsanywhere.app.ui.designsystem.dshAgentPresetLabel

/**
 * Read-only goal / task / sub-agent dialog for runtimes that report insights
 * (DSH). Shown from the header badge; every section renders only when the
 * runtime reports it.
 */
@Composable
fun SessionInsightsDialog(
    insights: SessionInsights,
    onOpenSubagent: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(android.R.string.ok)) }
        },
        title = null,
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                insights.agentPreset?.let { preset ->
                    InsightsSection(title = stringResource(R.string.session_insights_agent_preset)) {
                        Text(dshAgentPresetLabel(preset), style = MaterialTheme.typography.bodyMedium)
                    }
                }
                insights.goal?.let { goal ->
                    InsightsSection(title = stringResource(R.string.session_insights_goal)) {
                        Text(goal.objective, style = MaterialTheme.typography.bodyMedium)
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = goalPhaseLabel(goal.phase),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary,
                            )
                            Text(
                                text = stringResource(
                                    R.string.session_insights_goal_rounds,
                                    goal.roundsStarted,
                                    goal.maxGoalRounds,
                                ),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        goal.blockedMessage?.let {
                            Text(
                                text = it,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                }
                insights.todos?.takeIf { it.isNotEmpty() }?.let { todos ->
                    InsightsSection(title = stringResource(R.string.session_insights_todos)) {
                        todos.forEach { todo ->
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(
                                    text = todoStatusLabel(todo.status),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.padding(top = 2.dp),
                                )
                                Text(
                                    text = todo.content,
                                    style = MaterialTheme.typography.bodySmall,
                                    modifier = Modifier.weight(1f),
                                )
                            }
                        }
                    }
                }
                insights.subagentCatalog?.takeIf { it.isNotEmpty() }?.let { subagents ->
                    InsightsSection(title = stringResource(R.string.session_insights_subagents)) {
                        subagents.forEach { subagent ->
                            TextButton(
                                onClick = { onOpenSubagent(subagent.id) },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text(
                                    text = subagent.label
                                        ?: stringResource(R.string.session_insights_unnamed_subagent),
                                    style = MaterialTheme.typography.bodySmall,
                                    modifier = Modifier.weight(1f),
                                )
                                Text(
                                    text = subagentModeLabel(subagent.mode),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
        },
    )
}

@Composable
private fun InsightsSection(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            text = title,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        content()
    }
}

@Composable
private fun goalPhaseLabel(phase: String): String = when (phase) {
    "paused" -> stringResource(R.string.session_insights_goal_paused)
    "blocked" -> stringResource(R.string.session_insights_goal_blocked)
    "complete" -> stringResource(R.string.session_insights_goal_complete)
    else -> stringResource(R.string.session_insights_goal_active)
}

@Composable
private fun todoStatusLabel(status: String): String = when (status) {
    "in_progress" -> stringResource(R.string.session_insights_todo_in_progress)
    "completed" -> stringResource(R.string.session_insights_todo_completed)
    else -> stringResource(R.string.session_insights_todo_pending)
}

@Composable
private fun subagentModeLabel(mode: String): String = when (mode) {
    "one-shot" -> stringResource(R.string.session_insights_subagent_one_shot)
    "continuable" -> stringResource(R.string.session_insights_subagent_continuable)
    else -> stringResource(R.string.session_insights_subagent_unknown)
}
