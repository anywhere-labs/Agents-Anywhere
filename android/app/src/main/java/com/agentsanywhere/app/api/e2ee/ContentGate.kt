package com.agentsanywhere.app.api.e2ee

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.UploadFilePart
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import com.agentsanywhere.app.api.apiPath
import org.json.JSONObject
import java.net.URLDecoder
import java.util.concurrent.ConcurrentHashMap

/** 一个请求的内容属于哪里：某个会话（设备由会话的 `connectorId` 决定），或者直接属于某台设备。 */
sealed interface ContentTarget {
    data class Session(val sessionId: String) : ContentTarget
    data class Device(val deviceId: String, val kind: DeviceContent) : ContentTarget
}

enum class DeviceContent {
    /** `fs/list`、`fs/readText`：可以经通道。 */
    Files,

    /** `fs/read`：普通模式经 Server 中转明文文件；加密设备改用 [SecureFileReader] 分块读取。 */
    FileTransfer,

    /** `terminals-v2`：创建、列表、写入、调整大小、关闭经通道；终端流用 `stream: "terminal"` 订阅。 */
    Terminal,
}

/**
 * 哪些客户端 API 路径是会话 / 设备内容。
 *
 * - `/sessions/{id}/…` 下除 `meta`、`runtime/state`、`runtime/capabilities` 以外都是会话内容；
 * - `/runtime-workflows/sessions/{id}/…` (the Agent session behind a session: configuration, operations, close, recover) is session content too;
 * - `/connectors/{id}/fs/…`、`/connectors/{id}/terminals-v2…` 是设备内容；
 * - 其余（会话列表、创建会话、归档、设备管理、认证）不归通道管。
 */
object E2eeContentPaths {
    private val SESSION_PLAIN_SUBPATHS = setOf("meta", "runtime/state", "runtime/capabilities")

    fun classify(path: String): ContentTarget? {
        val pathname = apiPath(path).substringBefore('?').substringBefore('#').removePrefix("/api/v2")
        val segments = pathname.trim('/').split('/').filter { it.isNotEmpty() }.map(::decode)
        if (segments.size < 3) return null
        return when (segments[0]) {
            "sessions" -> {
                val rest = segments.drop(2).joinToString("/")
                if (rest in SESSION_PLAIN_SUBPATHS) null else ContentTarget.Session(segments[1])
            }
            "runtime-workflows" -> if (segments.size >= 4 && segments[1] == "sessions") ContentTarget.Session(segments[2]) else null
            "connectors" -> when {
                segments[2] == "fs" && segments.getOrNull(3) == "read" -> ContentTarget.Device(segments[1], DeviceContent.FileTransfer)
                segments[2] == "fs" -> ContentTarget.Device(segments[1], DeviceContent.Files)
                segments[2] == "terminals-v2" -> ContentTarget.Device(segments[1], DeviceContent.Terminal)
                else -> null
            }
            else -> null
        }
    }

    /** `/sessions/{id}/meta` 的会话 id；别的路径返回 null。 */
    fun metaSessionId(path: String): String? {
        val pathname = apiPath(path).substringBefore('?').substringBefore('#').removePrefix("/api/v2")
        val segments = pathname.trim('/').split('/').filter { it.isNotEmpty() }.map(::decode)
        return segments.takeIf { it.size == 3 && it[0] == "sessions" && it[2] == "meta" }?.get(1)
    }

    private fun decode(segment: String): String = runCatching { URLDecoder.decode(segment, "UTF-8") }.getOrDefault(segment)
}

/** 一个将要发出的 JSON 请求。`path` 是 [com.agentsanywhere.app.api.ApiClient] 收到的相对路径。 */
data class ContentRequest(
    val serverUrl: String,
    val method: String,
    val path: String,
    val bodyText: String?,
    val authorizationToken: String?,
)

/**
 * 内容请求的闸门：[com.agentsanywhere.app.api.ApiClient] 发每个 JSON 请求、上传附件之前问它。
 * 返回 null 表示照常走明文；返回 JSON 表示已经经通道完成；抛 [ApiException] 表示拒绝（绝不退回明文）。
 */
interface ContentGate {
    fun intercept(request: ContentRequest): JSONObject?

    /**
     * 附件上传：返回 null 照常明文上传；加密设备时加密后上传并返回 Server 的响应
     * （`size`、`sha256` 换成明文的值）；不能明文上传时抛 [ApiException]。
     */
    fun upload(request: ContentRequest, files: List<UploadFilePart>): JSONObject?

    /** 这台设备的内容是否经通道；需要配对（不能走明文）时抛 [ApiException]。 */
    fun isEncryptedDevice(serverUrl: String, token: String?, deviceId: String): Boolean

    /** 这个会话的内容是否经通道；需要配对时抛 [ApiException]。 */
    fun isEncryptedSession(serverUrl: String, token: String?, sessionId: String): Boolean

    /** 加密设备的分块文件读取；普通设备返回 null。 */
    fun secureFiles(serverUrl: String, token: String?, deviceId: String): SecureFileReader?

    /**
     * 终端流：加密设备返回一个经通道的 [WebSocket]（订阅 `stream: "terminal"`），普通设备返回 null。
     * `url` 是普通模式的 `…/terminals-v2/{id}/stream?fromSeq=…&token=…`。
     */
    fun terminalSocket(url: String, listener: WebSocketListener): WebSocket?

    /** 一个加密模式错误码对应的、已本地化的拒绝。 */
    fun refusal(code: String): ApiException
}

/** `GET /api/v2/connectors/{dev}/fs/read?path&offset&length` 经通道，一次一块。 */
fun interface SecureFileReader {
    fun read(root: String, path: String, offset: Long, length: Int): TunnelFileChunk
}

/** `TunnelFileChunk {encoding: "base64", data, offset, size, eof}`；`data` 是标准 base64。 */
data class TunnelFileChunk(val data: ByteArray, val offset: Long, val size: Long, val eof: Boolean) {
    companion object {
        /** 一块最多 8 MiB（`FILE_CHUNK_MAX_BYTES`）。 */
        const val MAX_BYTES = 8 * 1024 * 1024

        fun parse(json: JSONObject): TunnelFileChunk {
            if (json.optString("encoding", "base64") != "base64") throw ApiException("Unsupported file chunk encoding.")
            val data = try {
                java.util.Base64.getDecoder().decode(json.optString("data"))
            } catch (error: IllegalArgumentException) {
                throw ApiException("The device returned an unreadable file chunk.", cause = error)
            }
            val offset = json.optLong("offset", -1)
            val size = json.optLong("size", -1)
            if (offset < 0 || size < 0 || !json.has("eof") || data.size > MAX_BYTES) {
                throw ApiException("The device returned an unreadable file chunk.")
            }
            return TunnelFileChunk(data, offset, size, json.getBoolean("eof"))
        }
    }
}

/** 返回后由调用方在保存好引用之后再启动的 socket（避免回调早于调用方记下它）。 */
interface DeferredStartSocket {
    fun start()
}

/** 加密上传的请求头（`x-aa-sealed: segments-v1`）。 */
object SealedUpload {
    const val HEADER = "x-aa-sealed"
    const val VALUE = "segments-v1"
}

/** 进程内安装的闸门；App 启动时装上。没装时一切照常（未登录、测试）。 */
object E2eeContentGate {
    @Volatile
    var installed: ContentGate? = null
}

/**
 * 会话 → 设备（`connectorId`）。解析任何会话 JSON 时记下；第一次记下后不再被改写：
 * 同一个会话的设备不会变，Server 改写它也不能把已知会话挪到一台不要求加密的设备上。
 */
object SessionDeviceDirectory {
    private val devices = ConcurrentHashMap<String, String>()

    fun remember(sessionId: String, deviceId: String) {
        if (sessionId.isNotBlank() && deviceId.isNotBlank()) devices.putIfAbsent(sessionId, deviceId)
    }

    fun deviceFor(sessionId: String): String? = devices[sessionId]

    fun clear() = devices.clear()
}

/** 加密模式相关的错误码（Server / 契约以外，客户端自己的）。 */
object E2eeClientErrorCodes {
    const val TIMEOUT = "e2ee_timeout"
    const val ATTACHMENTS_UNSUPPORTED = "e2ee_attachments_unsupported"
    const val FILE_TRANSFER_UNSUPPORTED = "e2ee_file_transfer_unsupported"

    /** 加密设备上带附件或用配置向导新建会话（附件要先上传到已有的会话；向导要经 Server 准备）。 */
    const val CREATE_UNSUPPORTED = "e2ee_create_unsupported"

    /** 加密设备上的会话暂不支持改名（标题也是内容，不能明文发给 Server；设备端支持后改为经通道）。 */
    const val RENAME_UNSUPPORTED = "e2ee_rename_unsupported"
}
