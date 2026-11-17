package com.agentsanywhere.app.feature.e2ee

import com.agentsanywhere.app.api.e2ee.DeferredStartSocket
import com.agentsanywhere.app.api.e2ee.toJsonObjectOrThrow
import com.agentsanywhere.app.api.urlEncode
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 终端流经设备安全通道，对外仍是一个 [WebSocket]，所以现有终端界面的数据源不用改：
 *
 * - 输出：订阅 `stream: "terminal"`，每个事件就是普通模式下这条 WS 的一条消息，原样交给 [WebSocketListener.onMessage]；
 * - 输入、调整大小：普通模式下 WS 上的 `{type: "input"}` / `{type: "resize"}` 帧，改成经通道的
 *   `POST …/terminals-v2/{id}/write {dataBase64}`、`POST …/resize {cols, rows}`，按发送顺序逐个发出。
 */
internal class SecureTerminalSocket(
    url: String,
    private val deviceId: String,
    private val terminalId: String,
    private val fromSeq: Long,
    private val client: E2eeClient,
    private val listener: WebSocketListener,
    private val translate: (Exception) -> Exception,
) : WebSocket, DeferredStartSocket {
    private val request = Request.Builder().url(url).build()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val outgoing = Channel<JSONObject>(Channel.UNLIMITED)
    private val closed = AtomicBoolean(false)
    private val started = AtomicBoolean(false)

    @Volatile
    private var unsubscribe: (() -> Unit)? = null

    private val basePath = "/connectors/${deviceId.urlEncode()}/terminals-v2/${terminalId.urlEncode()}"

    override fun start() {
        if (!started.compareAndSet(false, true)) return
        scope.launch {
            try {
                // Open first, like a WebSocket: the caller sends its size and queued input from onOpen.
                listener.onOpen(this@SecureTerminalSocket, openResponse())
                val stop = client.subscribeTerminal(
                    deviceId = deviceId,
                    terminalId = terminalId,
                    afterCursor = fromSeq.takeIf { it > 0 }?.let { "seq:$it" },
                    onEvent = { event -> if (!closed.get()) listener.onMessage(this@SecureTerminalSocket, event.toString()) },
                    onClosed = { error -> remoteClosed(error.code) },
                )
                unsubscribe = stop
                if (closed.get()) stop()
                for (frame in outgoing) deliver(frame)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                fail(translate(error))
            }
        }
    }

    override fun send(text: String): Boolean {
        if (closed.get()) return false
        val frame = runCatching { JSONObject(text) }.getOrNull() ?: return false
        return outgoing.trySend(frame).isSuccess
    }

    override fun send(bytes: ByteString): Boolean = false

    override fun close(code: Int, reason: String?): Boolean {
        shutdown()
        return true
    }

    override fun cancel() = shutdown()

    override fun queueSize(): Long = 0

    override fun request(): Request = request

    private suspend fun deliver(frame: JSONObject) {
        val (path, body) = when (frame.optString("type")) {
            "input" -> "$basePath/write" to JSONObject().put("dataBase64", frame.optString("data"))
            "resize" -> "$basePath/resize" to JSONObject().put("cols", frame.optInt("cols")).put("rows", frame.optInt("rows"))
            else -> return
        }
        client.requestRaw(deviceId, "POST", path, body.toString()).toJsonObjectOrThrow()
    }

    private fun remoteClosed(code: String) {
        if (!closed.compareAndSet(false, true)) return
        outgoing.close()
        listener.onClosed(this, 1001, code)
        scope.cancel()
    }

    private fun fail(error: Exception) {
        if (!closed.compareAndSet(false, true)) return
        unsubscribe?.invoke()
        outgoing.close()
        listener.onFailure(this, error, null)
        scope.cancel()
    }

    private fun shutdown() {
        if (!closed.compareAndSet(false, true)) return
        unsubscribe?.invoke()
        outgoing.close()
        scope.cancel()
    }

    private fun openResponse(): Response = Response.Builder()
        .request(request)
        .protocol(Protocol.HTTP_1_1)
        .code(101)
        .message("Switching Protocols")
        .build()
}
