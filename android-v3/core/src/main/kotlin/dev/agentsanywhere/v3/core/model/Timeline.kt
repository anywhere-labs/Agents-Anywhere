package dev.agentsanywhere.v3.core.model

import dev.agentsanywhere.v3.core.AAJson
import dev.agentsanywhere.v3.core.arr
import dev.agentsanywhere.v3.core.bool
import dev.agentsanywhere.v3.core.get
import dev.agentsanywhere.v3.core.long
import dev.agentsanywhere.v3.core.str
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// aa.v3.Sessions / Device / Terminals, mirroring connector-v3/src/core/timeline.ts and connector-v3/src/rpc/*.ts.
// Messages stay raw JSON: the renderer draws them and native code only reads a few fields.

@Serializable
data class ConfigChoice(val value: String, val name: String = "", val description: String? = null, val group: String? = null)

@Serializable
data class ConfigOption(
    val id: String,
    val name: String = "",
    val description: String? = null,
    /** "mode" | "model" | "thought_level" | "model_config" | … */
    val category: String? = null,
    val current: String = "",
    val options: List<ConfigChoice> = emptyList(),
) {
    val currentName: String get() = options.firstOrNull { it.value == current }?.name?.ifEmpty { null } ?: current
}

@Serializable
data class DeviceRef(val id: String, val name: String = "")

@Serializable
data class Session(
    val id: String,
    val title: String = "",
    val agent: String = "",
    val device: DeviceRef? = null,
    val cwd: String = "",
    val branch: String? = null,
    val created_at: String = "",
    val updated_at: String = "",
    val message_count: Long = 0,
    val config: List<ConfigOption> = emptyList(),
)

@Serializable
data class PermissionOption(val id: String, val name: String = "", val kind: String = "allow_once") {
    val allows: Boolean get() = kind.startsWith("allow")
}

@Serializable
data class PendingRequest(
    val request_id: String,
    val message_id: String = "",
    val tool_call_id: String = "",
    val title: String = "",
    val options: List<PermissionOption> = emptyList(),
)

@Serializable
data class AttachmentRef(val type: String = "file", val path: String, val name: String = "", val mime: String = "", val size: Long = 0)

@Serializable
data class QueuedMessage(val client_msg_id: String, val author: String = "", val content: String = "", val attachments: List<AttachmentRef>? = null)

@Serializable
data class Usage(val used: Long? = null, val size: Long? = null, val model: String? = null, val updated_at: String? = null)

@Serializable
data class Control(
    /** "idle" | "running" | "error" | "disconnected" */
    val state: String = "idle",
    /** "native" | "interrupt" | "none" */
    val steer: String = "none",
    val error: String? = null,
    val pending: List<PendingRequest> = emptyList(),
    val queued: List<QueuedMessage> = emptyList(),
    val usage: Usage? = null,
) {
    val running: Boolean get() = state == "running"
}

/** One `aa.v3.Sessions/watch` item, kept whole for the renderer plus the parts native code needs. */
class WatchEvent(val raw: JsonObject) {
    val type: String = raw["type"].str ?: ""
    val session: Session? by lazy { raw["session"]?.let { runCatching { AAJson.decodeFromJsonElement(Session.serializer(), it) }.getOrNull() } }
    val control: Control? by lazy { raw["control"]?.let { runCatching { AAJson.decodeFromJsonElement(Control.serializer(), it) }.getOrNull() } }
    val message: JsonObject? get() = raw["message"] as? JsonObject
    val messages: List<JsonObject> get() = raw["messages"].arr.filterIsInstance<JsonObject>()
    val hasMore: Boolean get() = raw["has_more"].bool ?: false
}

/** Plain text of a message (user text parts, or an assistant text part), for previews and the placeholder renderer. */
fun messageText(message: JsonElement?): String =
    message["parts"].arr.filter { it["type"].str == "text" }.joinToString("\n") { it["text"].str ?: "" }

fun messageSeq(message: JsonElement?): Long = message["seq"].long ?: 0

@Serializable
data class MessagesPage(val messages: List<JsonObject> = emptyList(), val has_more: Boolean = false, val next_cursor: String? = null)

@Serializable
data class SendAttachment(val path: String, val name: String? = null, val mime: String? = null, val size: Long? = null)

@Serializable
data class SendRequest(
    val id: String,
    val client_msg_id: String,
    val content: String,
    /** "auto" | "steer" | "queue" */
    val delivery: String? = null,
    val attachments: List<SendAttachment>? = null,
)

@Serializable
data class SendResult(val message_id: String = "", val session_id: String = "", val delivered: String = "started", val reply_text: String? = null)

@Serializable
data class CreateSessionRequest(val agent: String, val title: String? = null, val cwd: String? = null, val config: Map<String, String>? = null)

@Serializable
data class AnswerRequest(val id: String, val request_id: String, val option_id: String)

@Serializable
data class SetConfigRequest(val id: String, val config_id: String, val value: String)

@Serializable
data class QueuedRef(val id: String, val client_msg_id: String)

@Serializable
data class ListMessagesRequest(val id: String, val before_seq: Long? = null, val limit: Int? = null)

// aa.v3.Device

@Serializable
data class Runtime(val id: String, val name: String = "")

@Serializable
data class DeviceStatus(
    val device_id: String,
    val device_name: String = "",
    val platform: String = "",
    val hostname: String = "",
    val cwd: String = "",
    val arch: String = "",
    val node_version: String = "",
    val connector_version: String = "",
    val uptime_seconds: Long = 0,
    val mode: String = "normal",
    val allow_mcp: Boolean = false,
    val runtimes: List<Runtime> = emptyList(),
)

@Serializable
data class ReadFileRequest(val path: String, val offset_bytes: Long? = null, val max_bytes: Long? = null)

@Serializable
data class ReadFileResult(
    val path: String,
    val size: Long = 0,
    val offset: Long = 0,
    val bytes_read: Long = 0,
    val eof: Boolean = true,
    /** "utf8" | "base64" */
    val encoding: String = "utf8",
    val content: String = "",
    val mtime: String = "",
)

@Serializable
data class SaveAttachmentRequest(val name: String, val base64: String, val mime: String? = null, val session_id: String? = null)

@Serializable
data class SavedAttachment(val id: String = "", val path: String, val name: String = "", val mime: String = "", val size: Long = 0)

// aa.v3.Terminals

@Serializable
data class TerminalInfo(
    val id: String,
    val cwd: String = "",
    val shell: String = "",
    val cols: Int = 80,
    val rows: Int = 24,
    val created_at: String = "",
    val running: Boolean = true,
    val exit_code: Int? = null,
    val pid: Int? = null,
)

@Serializable
data class TerminalList(val terminals: List<TerminalInfo> = emptyList())

@Serializable
data class CreateTerminalRequest(val cwd: String? = null, val shell: String? = null, val cols: Int? = null, val rows: Int? = null)
