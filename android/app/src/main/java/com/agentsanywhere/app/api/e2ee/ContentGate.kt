package com.agentsanywhere.app.api.e2ee

import com.agentsanywhere.app.api.ApiException
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

    /** `fs/read`：要经 Server 中转明文文件，加密模式下还不支持。 */
    FileTransfer,

    /** `terminals-v2`：终端流没有经通道的形式（`TunnelSubscribe.stream` 只有 session），加密模式下还不支持。 */
    Terminal,
}

/**
 * 哪些客户端 API 路径是会话 / 设备内容。
 *
 * - `/sessions/{id}/…` 下除 `meta`、`runtime/state`、`runtime/capabilities` 以外都是会话内容；
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
            "connectors" -> when {
                segments[2] == "fs" && segments.getOrNull(3) == "read" -> ContentTarget.Device(segments[1], DeviceContent.FileTransfer)
                segments[2] == "fs" -> ContentTarget.Device(segments[1], DeviceContent.Files)
                segments[2] == "terminals-v2" -> ContentTarget.Device(segments[1], DeviceContent.Terminal)
                else -> null
            }
            else -> null
        }
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

    /** 附件上传：返回 false 照常上传；不能明文上传时抛 [ApiException]。 */
    fun checkUpload(request: ContentRequest): Boolean
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
    const val TERMINAL_UNSUPPORTED = "e2ee_terminal_unsupported"
    const val FILE_TRANSFER_UNSUPPORTED = "e2ee_file_transfer_unsupported"
}
