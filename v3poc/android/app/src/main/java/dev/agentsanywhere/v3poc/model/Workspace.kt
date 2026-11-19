package dev.agentsanywhere.v3poc.model

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** The sidebar data (`watch_list` in v3), decoded from fixtures/workspace.json. */
@Serializable
data class Workspace(
    val account: Account,
    val devices: List<Device>,
    val projects: List<Project>,
    val sessions: List<Session>,
) {
    @Serializable data class Account(val name: String, val email: String)
    @Serializable data class Device(val id: String, val name: String, val presence: String, val platform: String) {
        val isOnline: Boolean get() = presence == "online"
    }
    @Serializable data class Project(val device_id: String, val cwd: String, val name: String, val remoteId: String? = null) {
        val id: String get() = "$device_id:$cwd"
    }
    @Serializable data class Session(
        val id: String,
        val title: String,
        val agent: String,
        val device_id: String,
        val cwd: String,
        val state: String,
        val unread: Boolean,
        val pinned: Boolean,
        val updated_at: String,
    ) {
        val agentLabel: String get() = when (agent) {
            "codex" -> "Codex"
            "claude" -> "Claude Code"
            "dsh" -> "DeepSeek Harness"
            else -> agent
        }
    }
}

/** Fixtures copied into assets/fixtures by the `copyPocAssets` Gradle task. */
object Fixtures {
    fun workspace(context: Context): Workspace = runCatching {
        AAJson.decodeFromString(Workspace.serializer(), read(context, "workspace.json"))
    }.getOrElse { Workspace(Workspace.Account("demo", ""), emptyList(), emptyList(), emptyList()) }

    /** `{ account, snapshot, script, reply }`. */
    fun demo(context: Context): JsonObject? = runCatching {
        AAJson.parseToJsonElement(read(context, "session-demo.json")) as JsonObject
    }.getOrNull()

    private fun read(context: Context, name: String) = context.assets.open("fixtures/$name").bufferedReader().use { it.readText() }
}

/** Session state as the shell shows it (toolbar status, sidebar indicator). */
enum class SessionActivity {
    Idle, Running, Waiting, Error, Disconnected;

    companion object {
        fun summary(state: String) = when (state) {
            "running" -> Running
            "waiting" -> Waiting
            "error" -> Error
            "disconnected" -> Disconnected
            else -> Idle
        }

        /** From a v3 `Control`: a pending request means someone has to answer. */
        fun control(control: JsonObject?): SessionActivity {
            if (control == null) return Idle
            if (!control["pending"].arr.isNullOrEmpty()) return Waiting
            return summary(control["state"].str ?: "idle")
        }
    }
}
