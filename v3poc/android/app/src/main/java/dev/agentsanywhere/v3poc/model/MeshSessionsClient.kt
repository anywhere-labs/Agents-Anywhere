package dev.agentsanywhere.v3poc.model

import android.net.Uri
import dev.agentsanywhere.v3poc.generated.ContentRequest
import dev.agentsanywhere.v3poc.generated.ContentSubscribeRequest
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal class DeviceRequestRejected(val code: String?, message: String) : Exception(message)

private val terminalStatuses = setOf("done", "failed", "cancelled", "interrupted")

internal class MeshSessionsClient(
    private val device: Workspace.Device,
    private val sessionTitles: Map<String, String>,
    val runtimes: List<RuntimeChoice> = emptyList(),
    val upload: (suspend (String, Uri) -> StagedAttachment)? = null,
    private val settingLabels: Map<String, String> = emptyMap(),
    private val deliveryFailure: ((String?) -> String)? = null,
    private val connect: suspend () -> PairedContent,
) : SessionsClient {
    override fun watch(id: String): Flow<JsonObject> = flow {
        var transport: DeviceContentTransport? = null
        try {
            val pair = connect()
            transport = pair.transport
            pair.transport.subscribe(ContentSubscribeRequest(sessionId = id), pair.authorization).collect {
                emit(snapshot(id))
            }
        } catch (_: Exception) {
            // Failed and completed streams both require reopening the device tunnel.
        }
        currentCoroutineContext().ensureActive()
        emit(jsObj("type" to "control", "control" to control("disconnected")))
        transport?.invalidate()
    }

    override suspend fun listMessages(id: String, beforeSeq: Int?, limit: Int): Pair<List<JsonElement>, Boolean> {
        val mode = beforeSeq?.let { "history&beforeOrderSeq=$it" } ?: "latest"
        val page = request(id, "GET", "timeline?mode=$mode&limit=$limit")
        return messages(page["items"].arr.orEmpty()) to (page["hasMore"].bool ?: false)
    }

    override suspend fun send(id: String, clientMsgId: String, content: String): String {
        return send(id, clientMsgId, content, emptyList())
    }

    suspend fun send(id: String, clientMsgId: String, content: String, attachments: List<StagedAttachment>): String {
        val payload = buildJsonObject {
            put("clientMessageId", clientMsgId)
            put("content", content)
            if (attachments.isNotEmpty()) {
                put("attachments", JsonArray(attachments.map { it.reference }))
                put("sealedAttachmentKeys", JsonArray(attachments.map { it.key }))
            }
        }
        val receipt = request(id, "POST", "runtime/messages", payload)["result"]
        if (receipt["clientMessageId"].str != clientMsgId || receipt["delivery"].str !in setOf("accepted", "queued", "duplicate")) {
            throw SessionsClientException("Missing device receipt")
        }
        return clientMsgId
    }

    override suspend fun answer(id: String, requestId: String, optionId: String) {
        request(id, "POST", "runtime/notices/${Uri.encode(requestId)}/respond",
            jsObj("actionId" to optionId, "responseId" to UUID.randomUUID().toString()))
    }

    override suspend fun stop(id: String) {
        request(id, "POST", "runtime/interrupt", jsObj("commandId" to UUID.randomUUID().toString()))
    }

    override suspend fun setConfig(id: String, configId: String, value: String): JsonObject {
        request(id, "PATCH", "runtime/selections", jsObj("selections" to jsObj(configId to value)))
        return snapshot(id)["session"] as JsonObject
    }

    suspend fun create(runtime: RuntimeChoice, cwd: String, content: String, operationId: String,
                       project: Workspace.Project?): Workspace.Session {
        val title = content.lineSequence().first().take(80)
        val request = buildJsonObject {
            put("connectorId", device.id)
            put("runtime", runtime.type)
            put("runtimeId", runtime.id)
            put("cwd", cwd)
            put("content", content)
            put("title", title)
            put("clientMessageId", operationId)
            project?.remoteId?.let { put("projectId", it) }
        }
        val response = deviceRequest("POST", "/api/v2/sessions/create-and-start", request)
        val session = response["session"]
        val id = session["id"].str ?: throw SessionsClientException("Session ID missing")
        return Workspace.Session(
            id, session["title"].str?.takeIf(String::isNotBlank) ?: title,
            runtime.type, device.id, cwd, session["status"].str ?: "running", false, false,
            session["lastActivityAt"].str ?: Instant.now().toString(),
        )
    }

    private val workspacePath get() = "/api/v2/connectors/${Uri.encode(device.id)}"

    suspend fun readFile(root: String, path: String): String {
        val result = deviceRequest("POST", "$workspacePath/fs/readText?root=${Uri.encode(root)}",
            jsObj("path" to path, "maxBytes" to 256 * 1024))
        return result["content"].str ?: throw SessionsClientException("Text unavailable")
    }

    suspend fun startTerminal(root: String): String =
        deviceRequest("POST", "$workspacePath/terminals-v2?root=${Uri.encode(root)}",
            jsObj("cols" to 80, "rows" to 24))["result"]["terminalId"].str
            ?: throw SessionsClientException("Terminal ID missing")

    suspend fun writeTerminal(id: String, line: String) {
        val data = java.util.Base64.getEncoder().encodeToString((line + "\n").encodeToByteArray())
        deviceRequest("POST", "$workspacePath/terminals-v2/${Uri.encode(id)}/write", jsObj("dataBase64" to data))
    }

    suspend fun closeTerminal(id: String) {
        deviceRequest("DELETE", "$workspacePath/terminals-v2/${Uri.encode(id)}")
    }

    fun terminalEvents(id: String, fromSeq: Long): Flow<JsonObject> = flow {
        val peer = connect()
        try {
            peer.transport.subscribe(ContentSubscribeRequest(stream = "terminal", terminalId = id, fromSeq = fromSeq),
                peer.authorization).collect { if (it is JsonObject) emit(it) }
        } catch (failure: Exception) {
            currentCoroutineContext().ensureActive()
            peer.transport.invalidate()
            throw failure
        }
    }

    private suspend fun request(id: String, method: String, path: String, body: JsonObject? = null): JsonObject =
        deviceRequest(method, "/api/v2/sessions/${Uri.encode(id)}/$path", body)

    private suspend fun deviceRequest(method: String, path: String, body: JsonObject? = null): JsonObject {
        val pair = connect()
        val result = pair.transport.request(ContentRequest(body, method, path), pair.authorization)
        val payload = result.body as? JsonObject ?: jsObj()
        if (result.status !in 200L..299L || payload["ok"].bool == false) {
            throw DeviceRequestRejected(payload["detail"]["code"].str ?: payload["code"].str,
                payload["detail"]["message"].str ?: payload["message"].str ?: "HTTP ${result.status}")
        }
        return payload
    }

    private suspend fun snapshot(id: String): JsonObject {
        val data = request(id, "GET", "snapshot")
        val session = data["session"]
        val timeline = data["timeline"]
        val items = messages(timeline["items"].arr.orEmpty())
        val time = session["lastActivityAt"].str ?: Instant.now().toString()
        val title = session["title"].str?.takeIf(String::isNotBlank) ?: sessionTitles[id].orEmpty()
        return jsObj(
            "type" to "snapshot",
            "session" to jsObj(
                "id" to id, "title" to title,
                "takeover" to session["takeover"].bool, "archived" to session["archived"].bool,
                "agent" to session["runtimeType"].str.orEmpty(),
                "device" to jsObj("id" to device.id, "name" to device.name),
                "cwd" to session["cwd"].str.orEmpty(), "created_at" to time, "updated_at" to time,
                "message_count" to items.size, "config" to config(data),
            ),
            "messages" to JsonArray(items), "has_more" to (timeline["hasMore"].bool ?: false),
            "control" to control(data["state"]["status"].str ?: session["status"].str ?: "idle")
                .with("pending" to pending(data["notices"])),
        )
    }

    private fun config(data: JsonObject): JsonArray {
        val allowed = data["effectiveCapabilities"]["capabilities"].arr.orEmpty()
            .filter { it["allowed"].bool == true && it["available"].bool == true }
            .mapNotNull { it["capabilityId"].str }.toSet()
        val out = listOf("model", "permission").mapNotNull { kind ->
            if ("catalog.$kind" !in allowed) return@mapNotNull null
            val values = data["catalogs"]["${kind}s"]["${kind}s"].arr.orEmpty().mapNotNull { entry ->
                val id = entry["selectionId"].str ?: entry["id"].str ?: return@mapNotNull null
                jsObj("value" to id, "name" to (entry["displayName"].str ?: id), "description" to entry["description"].str)
            }
            if (values.isEmpty()) return@mapNotNull null
            jsObj("id" to kind, "category" to kind, "name" to (settingLabels[kind] ?: kind),
                "current" to (data["state"]["selections"][kind].str ?: ""), "options" to values)
        }
        return JsonArray(out)
    }

    private fun pending(notices: JsonElement?): JsonArray =
        JsonArray(notices.arr.orEmpty().filter {
            it["status"].str == "open" && it["interactionType"].str == "approval" && it["responseRequired"].bool == true
        }.mapNotNull { notice ->
            val id = notice["noticeId"].str ?: return@mapNotNull null
            val choices = notice["actions"].arr.orEmpty().filter { it["input"]["required"].bool != true }.mapNotNull { action ->
                val option = action["actionId"].str ?: return@mapNotNull null
                jsObj("id" to option, "name" to (action["label"].str ?: option),
                    "kind" to if (action["style"].str == "danger") "reject_once" else "allow_once")
            }
            jsObj("request_id" to id, "message_id" to notice["source"]["timelineItemId"].str,
                "title" to notice["title"].str, "options" to choices)
        })

    private fun messages(items: List<JsonElement>): List<JsonObject> {
        var turnId: String? = null
        return items.mapNotNull { item ->
            val id = item["id"].str ?: return@mapNotNull null
            val seq = item["orderSeq"] ?: return@mapNotNull null
            val role = item["role"].str
            if (role != "user" && role != "assistant") return@mapNotNull null
            val text = item["content"]["text"].str ?: item["content"]["message"].str ?: return@mapNotNull null
            if (text.isEmpty()) return@mapNotNull null
            val thinking = item["content"]["isThinking"].bool == true
            if (role == "user") turnId = id
            buildJsonObject {
                put("id", id)
                put("seq", seq)
                put("role", if (role == "user") "user" else "assistant")
                put("created_at", item["createdAt"].str.orEmpty())
                put("done", item["status"].str in terminalStatuses)
                put("parts", JsonArray(listOf(jsObj("type" to if (thinking) "thinking" else "text", "text" to text))))
                if (role == "user") {
                    item["source"]["clientMessageId"].str?.let { put("client_msg_id", JsonPrimitive(it)) }
                    if (item["status"].str == "failed") {
                        deliveryFailure?.invoke(item["content"]["error"]["code"].str)?.let { put("delivery_error", it) }
                    }
                } else put("turn_id", turnId ?: id)
            }
        }
    }

    private fun control(state: String) =
        jsObj("state" to state, "steer" to "none", "pending" to JsonArray(emptyList()), "queued" to JsonArray(emptyList()))
}

internal data class RuntimeChoice(val id: String, val type: String, val name: String)
