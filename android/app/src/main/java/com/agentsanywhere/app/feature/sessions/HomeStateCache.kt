package com.agentsanywhere.app.feature.sessions

import android.content.Context
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentProject
import org.json.JSONArray
import org.json.JSONObject

class HomeStateCache(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("home_state_cache_v1", Context.MODE_PRIVATE)

    fun load(userId: String): SessionsState? {
        if (userId.isBlank()) return null
        val raw = prefs.getString("snapshot:$userId", null) ?: return null
        return runCatching {
            val root = JSONObject(raw)
            val devicesArr = root.optJSONArray("devices") ?: JSONArray()
            val devices = (0 until devicesArr.length()).mapNotNull { i ->
                val obj = devicesArr.optJSONObject(i) ?: return@mapNotNull null
                AgentDevice(
                    id = obj.getString("id"),
                    name = obj.getString("name"),
                    deviceOs = obj.optString("deviceOs").takeIf { it.isNotBlank() },
                    online = obj.optBoolean("online"),
                    lastSeenAt = obj.optString("lastSeenAt").takeIf { it.isNotBlank() },
                    createdAt = obj.optString("createdAt").takeIf { it.isNotBlank() },
                )
            }
            val projectsArr = root.optJSONArray("projects") ?: JSONArray()
            val projects = (0 until projectsArr.length()).mapNotNull { i ->
                val obj = projectsArr.optJSONObject(i) ?: return@mapNotNull null
                AgentProject(
                    id = obj.getString("id"),
                    userId = obj.optString("userId"),
                    connectorId = obj.optString("connectorId"),
                    name = obj.getString("name"),
                    workspacePath = obj.optString("workspacePath"),
                    pinned = obj.optBoolean("pinned"),
                    pinnedAt = obj.optString("pinnedAt").takeIf { it.isNotBlank() },
                    activeSessionCount = obj.optInt("activeSessionCount"),
                    lastActivityAt = obj.optString("lastActivityAt").takeIf { it.isNotBlank() },
                    createdAt = obj.optString("createdAt"),
                    updatedAt = obj.optString("updatedAt"),
                )
            }
            if (devices.isEmpty() && projects.isEmpty()) null
            else SessionsState(
                devices = devices,
                projects = projects,
                sessions = emptyList(),
                isLoading = false,
                hasLoaded = true,
            )
        }.getOrNull()
    }

    fun save(userId: String, state: SessionsState) {
        if (userId.isBlank() || !state.hasLoaded) return
        runCatching {
            val root = JSONObject()
            val devicesArr = JSONArray()
            state.devices.forEach { d ->
                devicesArr.put(JSONObject().apply {
                    put("id", d.id)
                    put("name", d.name)
                    put("deviceOs", d.deviceOs ?: "")
                    put("online", d.online)
                    put("lastSeenAt", d.lastSeenAt ?: "")
                    put("createdAt", d.createdAt ?: "")
                })
            }
            val projectsArr = JSONArray()
            state.projects.forEach { p ->
                projectsArr.put(JSONObject().apply {
                    put("id", p.id)
                    put("userId", p.userId)
                    put("connectorId", p.connectorId)
                    put("name", p.name)
                    put("workspacePath", p.workspacePath)
                    put("pinned", p.pinned)
                    put("pinnedAt", p.pinnedAt ?: "")
                    put("activeSessionCount", p.activeSessionCount)
                    put("lastActivityAt", p.lastActivityAt ?: "")
                    put("createdAt", p.createdAt)
                    put("updatedAt", p.updatedAt)
                })
            }
            root.put("devices", devicesArr)
            root.put("projects", projectsArr)
            prefs.edit().putString("snapshot:$userId", root.toString()).apply()
        }
    }
}
