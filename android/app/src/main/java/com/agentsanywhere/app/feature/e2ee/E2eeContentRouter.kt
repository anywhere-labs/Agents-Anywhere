package com.agentsanywhere.app.feature.e2ee

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.UploadFilePart
import com.agentsanywhere.app.api.e2ee.ChannelClosedException
import com.agentsanywhere.app.api.e2ee.ContentGate
import com.agentsanywhere.app.api.e2ee.ContentRequest
import com.agentsanywhere.app.api.e2ee.ContentTarget
import com.agentsanywhere.app.api.e2ee.DeviceContent
import com.agentsanywhere.app.api.e2ee.E2eeClientErrorCodes
import com.agentsanywhere.app.api.e2ee.E2eeContentPaths
import com.agentsanywhere.app.api.e2ee.E2eeErrorCodes
import com.agentsanywhere.app.api.e2ee.E2eeFormats
import com.agentsanywhere.app.api.e2ee.SealedPurpose
import com.agentsanywhere.app.api.e2ee.SealedUpload
import com.agentsanywhere.app.api.e2ee.SecureFileReader
import com.agentsanywhere.app.api.e2ee.SessionDeviceDirectory
import com.agentsanywhere.app.api.e2ee.TunnelFileChunk
import com.agentsanywhere.app.api.e2ee.toJsonObjectOrThrow
import com.agentsanywhere.app.api.apiPath
import com.agentsanywhere.app.api.urlEncode
import com.agentsanywhere.app.api.e2ee.noise.NoiseCrypto
import com.agentsanywhere.app.feature.realtime.SessionStreamRouter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/** Server 收下的一个附件（上传响应里的一项）。 */
fun interface SealedUploader {
    /** `POST /sessions/{id}/attachments`，带 `x-aa-sealed: segments-v1`；`files` 的内容已经是分段密文。 */
    fun upload(serverUrl: String, token: String?, path: String, files: List<UploadFilePart>, headers: Map<String, String>): JSONObject
}

/**
 * 加密模式的路由：按会话的 `connectorId`（或路径里的设备）选择传输。
 *
 * - `Plain`：返回 null，照常走 HTTP / WS；
 * - `Secure`：经设备的安全通道；带 `clientMessageId` 的命令先登记输入摘要；引用了加密附件的请求体
 *   附上 `sealedAttachmentKeys`；
 * - `PairingRequired`：拒绝（绝不退回明文），并请界面弹出配对面板。
 *
 * [com.agentsanywhere.app.api.ApiClient] 的调用都在后台线程上阻塞执行，所以这里用 `runBlocking` 接到挂起的 [E2eeClient]。
 */
class E2eeContentRouter(
    private val client: E2eeClient,
    /** 不在 [SessionDeviceDirectory] 里的会话：读 `/sessions/{id}/meta`（明文路由）拿 `connectorId`。 */
    private val resolveSessionDevice: (serverUrl: String, token: String?, sessionId: String) -> String?,
    /** 错误码 → 给用户看的文案（ui 层注入本地化）。 */
    private val messages: (code: String) -> String = { it },
    private val sealedUploader: SealedUploader? = null,
    /** 加密附件的密钥，只在内存里。 */
    val sealedKeys: SealedAttachmentKeys = SealedAttachmentKeys(),
) : ContentGate, SessionStreamRouter {
    /** 一个请求最终走哪条路。 */
    sealed interface Route {
        data object Plain : Route
        data class Secure(val deviceId: String, val target: ContentTarget) : Route
    }

    /** 决定路线；需要配对时抛 [ApiException]。 */
    fun route(target: ContentTarget, serverUrl: String, token: String?): Route {
        if (!client.encryptionInPlay()) return Route.Plain
        val deviceId = when (target) {
            is ContentTarget.Device -> target.deviceId
            is ContentTarget.Session -> SessionDeviceDirectory.deviceFor(target.sessionId)
                ?: runCatching { resolveSessionDevice(serverUrl, token, target.sessionId) }.getOrNull()
                    ?.also { SessionDeviceDirectory.remember(target.sessionId, it) }
        }
        if (deviceId == null) {
            if (client.requiresEncryptionForUnknownDevice()) throw failure(E2eeErrorCodes.E2EE_REQUIRED, 409)
            return Route.Plain
        }
        return when (client.transportFor(deviceId)) {
            DeviceTransport.Plain -> Route.Plain
            is DeviceTransport.PairingRequired -> {
                client.promptPairing(deviceId)
                throw failure(E2eeErrorCodes.E2EE_REQUIRED, 409)
            }
            is DeviceTransport.Secure -> Route.Secure(deviceId, target)
        }
    }

    override fun intercept(request: ContentRequest): JSONObject? {
        if (request.method == "POST" && isCreateAndStart(request.path)) return createAndStart(request)
        if (request.method == "PATCH") refuseEncryptedRename(request)
        val target = E2eeContentPaths.classify(request.path) ?: return null
        val route = route(target, request.serverUrl, request.authorizationToken) as? Route.Secure ?: return null
        // The normal-mode file transfer would pass the Server in plaintext; FilesApi reads in chunks instead.
        if (target is ContentTarget.Device && target.kind == DeviceContent.FileTransfer) {
            throw failure(E2eeClientErrorCodes.FILE_TRANSFER_UNSUPPORTED, 409)
        }
        return sendThroughChannel(route.deviceId, request.method, request.path, request.bodyText)
    }

    override fun upload(request: ContentRequest, files: List<UploadFilePart>): JSONObject? {
        val target = E2eeContentPaths.classify(request.path) ?: return null
        val route = route(target, request.serverUrl, request.authorizationToken) as? Route.Secure ?: return null
        val uploader = sealedUploader ?: throw failure(E2eeClientErrorCodes.ATTACHMENTS_UNSUPPORTED, 409)
        val sealed = files.map { file -> SealedFile.seal(file) }
        val response = uploader.upload(
            request.serverUrl,
            request.authorizationToken,
            request.path,
            sealed.map { it.part },
            mapOf(SealedUpload.HEADER to SealedUpload.VALUE),
        )
        val attachments = response.optJSONArray("attachments") ?: JSONArray()
        if (attachments.length() != sealed.size) throw ApiException("The server did not accept every attachment.", 502)
        for (index in sealed.indices) {
            val item = attachments.getJSONObject(index)
            val file = sealed[index]
            val serverSha = item.optString("sha256").lowercase()
            // The Server only ever saw ciphertext: what it stored must be exactly what we sent.
            if (item.optLong("size", -1) != file.part.bytes.size.toLong() || (serverSha.isNotEmpty() && serverSha != file.ciphertextSha256)) {
                throw ApiException("The server stored a different attachment than the one uploaded.", 502)
            }
            val fileId = item.getString("fileId")
            sealedKeys.remember(fileId, file.keyFor(fileId), route.deviceId)
            // Callers check the plaintext they hold; give them the real name, type, size and digest.
            item.put("size", file.plainSize).put("sha256", file.plainSha256).put("name", file.name).put("mediaType", file.mimeType)
        }
        return response
    }

    override fun isEncryptedDevice(serverUrl: String, token: String?, deviceId: String): Boolean =
        route(ContentTarget.Device(deviceId, DeviceContent.Files), serverUrl, token) is Route.Secure

    override fun isEncryptedSession(serverUrl: String, token: String?, sessionId: String): Boolean =
        route(ContentTarget.Session(sessionId), serverUrl, token) is Route.Secure

    override fun secureFiles(serverUrl: String, token: String?, deviceId: String): SecureFileReader? {
        val route = route(ContentTarget.Device(deviceId, DeviceContent.FileTransfer), serverUrl, token) as? Route.Secure ?: return null
        return SecureFileReader { root, path, offset, length ->
            val query = "root=${root.urlEncode()}&path=${path.urlEncode()}&offset=$offset&length=${length.coerceIn(1, TunnelFileChunk.MAX_BYTES)}"
            val json = runChannel(route.deviceId) {
                client.requestRaw(route.deviceId, "GET", "/connectors/${deviceId.urlEncode()}/fs/read?$query", null).toJsonObjectOrThrow()
            }
            TunnelFileChunk.parse(json)
        }
    }

    override fun terminalSocket(url: String, listener: WebSocketListener): WebSocket? {
        // HttpUrl only parses http(s); a terminal stream URL is ws(s).
        val parsed = url.replaceFirst(Regex("^ws(s?)://", RegexOption.IGNORE_CASE), "http$1://").toHttpUrlOrNull() ?: return null
        val segments = parsed.pathSegments
        val at = segments.indexOf("connectors")
        if (at < 0 || segments.getOrNull(at + 2) != "terminals-v2" || segments.getOrNull(at + 4) != "stream") return null
        val deviceId = segments[at + 1]
        val terminalId = segments[at + 3]
        val serverUrl = "${parsed.scheme}://${parsed.host}:${parsed.port}"
        val token = parsed.queryParameter("token")
        val route = route(ContentTarget.Device(deviceId, DeviceContent.Terminal), serverUrl, token) as? Route.Secure ?: return null
        return SecureTerminalSocket(
            url = url,
            deviceId = route.deviceId,
            terminalId = terminalId,
            fromSeq = parsed.queryParameter("fromSeq")?.toLongOrNull() ?: 0L,
            client = client,
            listener = listener,
            translate = { translate(route.deviceId, it) },
        )
    }

    override suspend fun openSecureStream(
        serverUrl: String,
        token: String?,
        sessionId: String,
        afterCursor: String?,
        onMessage: (String) -> Unit,
        onClosed: () -> Unit,
    ): (() -> Unit)? {
        val route = route(ContentTarget.Session(sessionId), serverUrl, token) as? Route.Secure ?: return null
        return try {
            client.subscribe(
                deviceId = route.deviceId,
                sessionId = sessionId,
                afterCursor = afterCursor,
                // Same envelope as a normal-mode session WebSocket message.
                onEvent = { event -> onMessage(event.toString()) },
                onClosed = { onClosed() },
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            throw translate(route.deviceId, error)
        }
    }

    override fun refusal(code: String): ApiException = failure(code, 409)

    /** 退出登录：忘掉会话与设备的对应、加密附件的密钥，关闭所有通道。 */
    fun resetForLogout() {
        SessionDeviceDirectory.clear()
        sealedKeys.clear()
        client.closeAll()
    }

    /**
     * 加密设备上新建会话：整个 `create-and-start` 请求（路径、请求体与普通模式相同，含标题、第一条消息、
     * `/goal`、`/plan`）经通道发给 `connectorId` 选中的设备，由设备建会话、运行并把元数据同步给 Server。
     * 第一条消息和其他消息一样登记为命令。附件要先上传到已有的会话，新建时还没有会话，所以拒绝。
     */
    private fun createAndStart(request: ContentRequest): JSONObject? {
        val body = request.bodyText?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return null
        val deviceId = body.optString("connectorId").takeIf { it.isNotBlank() } ?: return null
        val route = route(ContentTarget.Device(deviceId, DeviceContent.Files), request.serverUrl, request.authorizationToken)
        if (route !is Route.Secure) return null
        if ((body.optJSONArray("attachments")?.length() ?: 0) > 0) throw failure(E2eeClientErrorCodes.CREATE_UNSUPPORTED, 409)
        val created = try {
            sendThroughChannel(deviceId, "POST", request.path, request.bodyText, CREATE_TIMEOUT_MS)
        } catch (error: ApiException) {
            // The device may have created the session before the answer was lost: let the caller reconcile.
            if (error.errorCode == E2eeClientErrorCodes.TIMEOUT) throw unknownCreateOutcome(error)
            throw error
        }
        val sessionId = created.optJSONObject("session")?.optString("id").orEmpty()
        if (sessionId.isBlank()) throw ApiException("The device returned an invalid session.", 502)
        SessionDeviceDirectory.remember(sessionId, deviceId)
        return created
    }

    /**
     * 改名会把标题明文交给 Server：加密设备上的会话暂时在本机拒绝（与 iOS 一致）。
     * 只改置顶、归档的 `meta` 请求不含内容，照常发。设备端支持后，改为把同一请求经通道发出。
     */
    private fun refuseEncryptedRename(request: ContentRequest) {
        val sessionId = E2eeContentPaths.metaSessionId(request.path) ?: return
        val body = request.bodyText?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return
        if (!body.has("title")) return
        if (route(ContentTarget.Session(sessionId), request.serverUrl, request.authorizationToken) is Route.Secure) {
            throw failure(E2eeClientErrorCodes.RENAME_UNSUPPORTED, 409)
        }
    }

    /** 结果不确定（超时，或这条命令之前已经发过）：不带状态码、原因是 IO 错误，调用方按网络中断去核对。 */
    private fun unknownCreateOutcome(cause: Throwable?) = ApiException(
        message = messages(E2eeClientErrorCodes.TIMEOUT),
        cause = java.io.IOException("The create request went to the device, but its result is unknown.", cause),
        errorCode = E2eeClientErrorCodes.TIMEOUT,
    )

    private fun sendThroughChannel(
        deviceId: String,
        method: String,
        path: String,
        bodyText: String?,
        timeoutMillis: Long? = null,
    ): JSONObject = runChannel(deviceId) {
        val body = bodyText?.let { withSealedKeys(it, deviceId) }
        val commandId = commandId(method, body)
        val response = if (commandId != null && body != null) {
            if (timeoutMillis != null) client.sendCommand(deviceId, commandId, method, path, body, timeoutMillis)
            else client.sendCommand(deviceId, commandId, method, path, body)
        } else {
            if (timeoutMillis != null) client.requestRaw(deviceId, method, path, body, timeoutMillis)
            else client.requestRaw(deviceId, method, path, body)
        }
        response.toJsonObjectOrThrow()
    }

    /** 引用了加密附件的请求体：在同一请求体里附上 `sealedAttachmentKeys`（只经通道，不经 Server）。 */
    private fun withSealedKeys(bodyText: String, deviceId: String): String {
        val attachments = runCatching { JSONObject(bodyText).optJSONArray("attachments") }.getOrNull() ?: return bodyText
        val keys = JSONArray()
        for (index in 0 until attachments.length()) {
            val fileId = attachments.optJSONObject(index)?.optString("fileId").orEmpty()
            sealedKeys.keyFor(fileId, deviceId)?.let { keys.put(it.toJson()) }
        }
        if (keys.length() == 0) return bodyText
        return JSONObject(bodyText).put("sealedAttachmentKeys", keys).toString()
    }

    private fun <T> runChannel(deviceId: String, block: suspend () -> T): T = try {
        runBlocking { block() }
    } catch (error: CancellationException) {
        throw error
    } catch (error: Exception) {
        throw translate(deviceId, error)
    }

    private fun translate(deviceId: String, error: Exception): Exception = when (error) {
        is ApiException -> error
        is E2eeTimeoutException -> failure(E2eeClientErrorCodes.TIMEOUT, 504, error)
        is ChannelClosedException -> {
            val needsPairing = error.code == E2eeErrorCodes.NOT_PAIRED || error.code == E2eeErrorCodes.DEVICE_PIN_MISMATCH
            if (needsPairing) client.promptPairing(deviceId)
            failure(error.code, if (needsPairing) 409 else 503, error)
        }
        else -> ApiException(error.message ?: messages(E2eeErrorCodes.PROTOCOL_ERROR), cause = error, errorCode = E2eeErrorCodes.PROTOCOL_ERROR)
    }

    private fun failure(code: String, status: Int, cause: Throwable? = null) =
        ApiException(message = messages(code), statusCode = status, cause = cause, errorCode = code)

    private fun commandId(method: String, bodyText: String?): String? {
        if (method == "GET" || bodyText.isNullOrBlank()) return null
        val body = runCatching { JSONObject(bodyText) }.getOrNull() ?: return null
        return sequenceOf("clientMessageId", "operationId", "responseId", "commandId")
            .mapNotNull { body.opt(it) as? String }.firstOrNull { it.isNotBlank() }
    }

    private fun isCreateAndStart(path: String): Boolean =
        apiPath(path).substringBefore('?').removePrefix("/api/v2") == "/sessions/create-and-start"

    private companion object {
        /** 与普通模式 create-and-start 的读超时相同：设备要建会话并启动 Runtime。 */
        const val CREATE_TIMEOUT_MS = 75_000L
    }
}

/** 一个加密好的上传文件。 */
internal class SealedFile private constructor(
    val part: UploadFilePart,
    val key: ByteArray,
    val plainSize: Long,
    val plainSha256: String,
    val ciphertextSha256: String,
    /** The real file name and type: they travel only in the channel, with the key. */
    val name: String,
    val mimeType: String,
) {
    fun keyFor(fileId: String) = SealedAttachmentKey(fileId, E2eeFormats.b64url(key), plainSize, plainSha256, name, mimeType)

    companion object {
        /** The Server sees only this name and type; the real ones go in [SealedAttachmentKey]. */
        const val UPLOAD_NAME = "attachment.bin"
        const val UPLOAD_TYPE = "application/octet-stream"

        /** 随机密钥；分段 AD 的 objectId 是明文的 SHA-256（十六进制小写）；上传体是各段密文直接拼接。 */
        fun seal(file: UploadFilePart, key: ByteArray = E2eeFormats.newObjectKey()): SealedFile {
            val sha256 = E2eeFormats.hex(NoiseCrypto.sha256(file.bytes))
            val body = ByteArrayOutputStream()
            E2eeFormats.sealSegments(SealedPurpose.Attachment, sha256, key, file.bytes).forEach(body::write)
            val ciphertext = body.toByteArray()
            return SealedFile(
                part = UploadFilePart(UPLOAD_NAME, UPLOAD_TYPE, ciphertext),
                key = key,
                plainSize = file.bytes.size.toLong(),
                plainSha256 = sha256,
                ciphertextSha256 = E2eeFormats.hex(NoiseCrypto.sha256(ciphertext)),
                name = file.name,
                mimeType = file.mediaType.ifBlank { UPLOAD_TYPE },
            )
        }
    }
}

/** `SealedAttachmentKey {fileId, key, size, sha256, name?, mimeType?}`；只在内存里，从不写盘。 */
data class SealedAttachmentKey(
    val fileId: String,
    val key: String,
    val size: Long,
    val sha256: String,
    val name: String? = null,
    val mimeType: String? = null,
) {
    fun toJson(): JSONObject = JSONObject().put("fileId", fileId).put("key", key).put("size", size).put("sha256", sha256).apply {
        name?.let { put("name", it) }
        mimeType?.let { put("mimeType", it) }
    }
}

/** 加密附件的密钥：只在内存里，按 fileId 记，只交给上传时所在的那台设备。 */
class SealedAttachmentKeys {
    private val keys = java.util.concurrent.ConcurrentHashMap<String, Pair<String, SealedAttachmentKey>>()

    fun remember(fileId: String, key: SealedAttachmentKey, deviceId: String) {
        keys[fileId] = deviceId to key
    }

    fun keyFor(fileId: String, deviceId: String): SealedAttachmentKey? = keys[fileId]?.takeIf { it.first == deviceId }?.second

    fun clear() = keys.clear()
}
