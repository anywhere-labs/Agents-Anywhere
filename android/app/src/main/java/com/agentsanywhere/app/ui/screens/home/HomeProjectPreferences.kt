package com.agentsanywhere.app.ui.screens.home

import android.content.SharedPreferences
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import org.json.JSONArray

internal class HomeProjectPreferences(private val storage: SharedPreferences, private val key: String) {
    var expandedIds by mutableStateOf(storage.getStringSet("$key:ids", emptySet()).orEmpty().toSet())
        private set
    var projectsExpanded by mutableStateOf(storage.getBoolean("$key:section", true))
        private set

    fun setProjectExpanded(id: String, expanded: Boolean) {
        expandedIds = if (expanded) expandedIds + id else expandedIds - id
        storage.edit().putStringSet("$key:ids", expandedIds).apply()
    }

    fun toggleSection() {
        projectsExpanded = !projectsExpanded
        storage.edit().putBoolean("$key:section", projectsExpanded).apply()
    }
}

@Composable
internal fun rememberHomeProjectPreferences(serverUrl: String, userId: String): HomeProjectPreferences {
    val context = LocalContext.current
    return remember(context, serverUrl, userId) {
        HomeProjectPreferences(
            context.getSharedPreferences("project_sidebar", 0),
            JSONArray(listOf(serverUrl.trim().trimEnd('/'), userId)).toString(),
        )
    }
}
