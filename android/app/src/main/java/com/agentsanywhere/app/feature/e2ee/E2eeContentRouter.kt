package com.agentsanywhere.app.feature.e2ee

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.e2ee.ChannelClosedException
import com.agentsanywhere.app.api.e2ee.ContentGate
import com.agentsanywhere.app.api.e2ee.ContentRequest
import com.agentsanywhere.app.api.e2ee.ContentTarget
import com.agentsanywhere.app.api.e2ee.DeviceContent
import com.agentsanywhere.app.api.e2ee.E2eeClientErrorCodes
import com.agentsanywhere.app.api.e2ee.E2eeContentPaths
import com.agentsanywhere.app.api.e2ee.E2eeErrorCodes
import com.agentsanywhere.app.api.e2ee.SessionDeviceDirectory
import com.agentsanywhere.app.api.e2ee.toJsonObjectOrThrow
import com.agentsanywhere.app.feature.realtime.SessionStreamRouter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.json.JSONObject

/**
 * 加密模式的路由：按会话的 `connectorId`（或路径里的设备）选择传输。
 *
 * - `Plain`：返回 null，照常走 HTTP / WS；
 * - `Secure`：经设备的安全通道；带 `clientMessageId` 的命令先登记输入摘要；
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
) : ContentGate, SessionStreamRouter {
    /** 一个请求最终走哪条路。 */
    sealed interface Route {
        data object Plain : Route
        data class Secure(val deviceId: String, val target: ContentTarget) : Route
    }

    /** 决定路线；需要配对或不支持时抛 [ApiException]。 */
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
        val target = E2eeContentPaths.classify(request.path) ?: return null
        val route = route(target, request.serverUrl, request.authorizationToken) as? Route.Secure ?: return null
        if (target is ContentTarget.Device) {
            when (target.kind) {
                DeviceContent.Terminal -> throw failure(E2eeClientErrorCodes.TERMINAL_UNSUPPORTED, 409)
                DeviceContent.FileTransfer -> throw failure(E2eeClientErrorCodes.FILE_TRANSFER_UNSUPPORTED, 409)
                DeviceContent.Files -> Unit
            }
        }
        return runChannel(route.deviceId) {
            val commandId = request.commandId()
            if (commandId != null) {
                client.sendCommand(route.deviceId, commandId, request.method, request.path, request.bodyText!!)
                    ?.toJsonObjectOrThrow()
                    // The Server already has this command: it was sent before, do not send it again.
                    ?: JSONObject().put("ok", true).put("duplicate", true)
            } else {
                client.requestRaw(route.deviceId, request.method, request.path, request.bodyText).toJsonObjectOrThrow()
            }
        }
    }

    override fun checkUpload(request: ContentRequest): Boolean {
        val target = E2eeContentPaths.classify(request.path) ?: return false
        if (route(target, request.serverUrl, request.authorizationToken) == Route.Plain) return false
        // Sealed uploads need a contract for where SealedAttachmentKey travels; until then refuse rather than leak.
        throw failure(E2eeClientErrorCodes.ATTACHMENTS_UNSUPPORTED, 409)
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

    private fun ContentRequest.commandId(): String? {
        if (method == "GET" || bodyText.isNullOrBlank()) return null
        return runCatching { JSONObject(bodyText).optString("clientMessageId") }.getOrNull()?.takeIf { it.isNotBlank() }
    }
}
