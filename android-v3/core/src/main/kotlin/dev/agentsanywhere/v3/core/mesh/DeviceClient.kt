package dev.agentsanywhere.v3.core.mesh

import dev.agentsanywhere.v3.core.AAJson
import dev.agentsanywhere.v3.core.mesh.DeviceTunnelPool.Companion.DEVICE
import dev.agentsanywhere.v3.core.mesh.DeviceTunnelPool.Companion.SESSIONS
import dev.agentsanywhere.v3.core.mesh.DeviceTunnelPool.Companion.TERMINALS
import dev.agentsanywhere.v3.core.model.AnswerRequest
import dev.agentsanywhere.v3.core.model.CreateSessionRequest
import dev.agentsanywhere.v3.core.model.CreateTerminalRequest
import dev.agentsanywhere.v3.core.model.DeviceStatus
import dev.agentsanywhere.v3.core.model.IdRequest
import dev.agentsanywhere.v3.core.model.ListMessagesRequest
import dev.agentsanywhere.v3.core.model.MessagesPage
import dev.agentsanywhere.v3.core.model.QueuedRef
import dev.agentsanywhere.v3.core.model.ReadFileRequest
import dev.agentsanywhere.v3.core.model.ReadFileResult
import dev.agentsanywhere.v3.core.model.SaveAttachmentRequest
import dev.agentsanywhere.v3.core.model.SavedAttachment
import dev.agentsanywhere.v3.core.model.SendAttachment
import dev.agentsanywhere.v3.core.model.SendRequest
import dev.agentsanywhere.v3.core.model.SendResult
import dev.agentsanywhere.v3.core.model.Session
import dev.agentsanywhere.v3.core.model.SessionList
import dev.agentsanywhere.v3.core.model.SessionListEvent
import dev.agentsanywhere.v3.core.model.SetConfigRequest
import dev.agentsanywhere.v3.core.model.TerminalInfo
import dev.agentsanywhere.v3.core.model.TerminalList
import dev.agentsanywhere.v3.core.model.WatchEvent
import io.github.t4wefan.meshcall.DuplexCall
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.util.UUID

/** The services a Connector serves to clients over a device tunnel: `aa.v3.Sessions`, `aa.v3.Device`, `aa.v3.Terminals`. */
class DeviceClient(private val pool: DeviceTunnelPool, val deviceId: String) {
    private suspend fun <Req, Res> call(service: String, method: String, request: Req, req: SerializationStrategy<Req>, res: DeserializationStrategy<Res>): Res =
        AAJson.decodeFromJsonElement(res, pool.unary(deviceId, service, method, AAJson.encodeToJsonElement(req, request)))

    private suspend fun <Res> call(service: String, method: String, request: JsonElement, res: DeserializationStrategy<Res>): Res =
        AAJson.decodeFromJsonElement(res, pool.unary(deviceId, service, method, request))

    private val empty: JsonElement get() = JsonObject(emptyMap())

    // aa.v3.Sessions

    suspend fun listSessions(limit: Int? = null): SessionList =
        call(SESSIONS, "list", if (limit == null) empty else AAJson.parseToJsonElement("{\"limit\":$limit}"), SessionList.serializer())

    fun watchList(): Flow<SessionListEvent> = pool.stream(deviceId, SESSIONS, "watch_list", empty)
        .mapNotNull { runCatching { AAJson.decodeFromJsonElement(SessionListEvent.serializer(), it) }.getOrNull() }

    suspend fun create(agent: String, cwd: String?, title: String? = null, config: Map<String, String>? = null): Session =
        call(SESSIONS, "create", CreateSessionRequest(agent, title, cwd, config), CreateSessionRequest.serializer(), Session.serializer())

    fun watch(sessionId: String): Flow<WatchEvent> = pool.stream(deviceId, SESSIONS, "watch", AAJson.encodeToJsonElement(IdRequest.serializer(), IdRequest(sessionId)))
        .mapNotNull { (it as? JsonObject)?.let(::WatchEvent) }

    suspend fun listMessages(sessionId: String, beforeSeq: Long?, limit: Int = 100): MessagesPage =
        call(SESSIONS, "list_messages", ListMessagesRequest(sessionId, beforeSeq, limit), ListMessagesRequest.serializer(), MessagesPage.serializer())

    suspend fun send(sessionId: String, text: String, delivery: String? = null, attachments: List<SendAttachment>? = null,
                     clientMsgId: String = "cm_" + UUID.randomUUID().toString().replace("-", "")): SendResult =
        call(SESSIONS, "send", SendRequest(sessionId, clientMsgId, text, delivery, attachments?.takeIf { it.isNotEmpty() }), SendRequest.serializer(), SendResult.serializer())

    suspend fun answer(sessionId: String, requestId: String, optionId: String) {
        call(SESSIONS, "answer", AnswerRequest(sessionId, requestId, optionId), AnswerRequest.serializer(), JsonObject.serializer())
    }

    suspend fun stop(sessionId: String) {
        call(SESSIONS, "stop", IdRequest(sessionId), IdRequest.serializer(), JsonObject.serializer())
    }

    suspend fun setConfig(sessionId: String, configId: String, value: String): Session =
        call(SESSIONS, "set_config", SetConfigRequest(sessionId, configId, value), SetConfigRequest.serializer(), Session.serializer())

    suspend fun rename(sessionId: String, title: String): Session =
        call(SESSIONS, "rename", dev.agentsanywhere.v3.core.jsonOf("id" to sessionId, "title" to title), Session.serializer())

    suspend fun delete(sessionId: String) {
        call(SESSIONS, "delete", IdRequest(sessionId), IdRequest.serializer(), JsonObject.serializer())
    }

    suspend fun steerQueued(sessionId: String, clientMsgId: String) {
        call(SESSIONS, "steer_queued", QueuedRef(sessionId, clientMsgId), QueuedRef.serializer(), JsonObject.serializer())
    }

    suspend fun unqueue(sessionId: String, clientMsgId: String) {
        call(SESSIONS, "unqueue", QueuedRef(sessionId, clientMsgId), QueuedRef.serializer(), JsonObject.serializer())
    }

    // aa.v3.Device

    suspend fun status(): DeviceStatus = call(DEVICE, "status", empty, DeviceStatus.serializer())

    suspend fun readFile(path: String, maxBytes: Long? = null): ReadFileResult =
        call(DEVICE, "read_file", ReadFileRequest(path, null, maxBytes), ReadFileRequest.serializer(), ReadFileResult.serializer())

    suspend fun saveAttachment(name: String, base64: String, mime: String?, sessionId: String?): SavedAttachment =
        call(DEVICE, "save_attachment", SaveAttachmentRequest(name, base64, mime, sessionId), SaveAttachmentRequest.serializer(), SavedAttachment.serializer())

    // aa.v3.Terminals

    suspend fun listTerminals(): List<TerminalInfo> = call(TERMINALS, "list", empty, TerminalList.serializer()).terminals

    suspend fun createTerminal(cwd: String? = null, cols: Int? = null, rows: Int? = null): TerminalInfo =
        call(TERMINALS, "create", CreateTerminalRequest(cwd, null, cols, rows), CreateTerminalRequest.serializer(), TerminalInfo.serializer())

    suspend fun closeTerminal(id: String) {
        call(TERMINALS, "close", IdRequest(id), IdRequest.serializer(), JsonObject.serializer())
    }

    /** `attach`: the open request (`{id, mode?, cols?, rows?}`), input frames and output frames stay raw JSON. */
    suspend fun attachTerminal(request: JsonObject): DuplexCall<JsonElement, JsonElement> = pool.duplex(deviceId, TERMINALS, "attach", request)
}
