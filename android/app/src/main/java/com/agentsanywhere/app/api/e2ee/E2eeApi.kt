package com.agentsanywhere.app.api.e2ee

import com.agentsanywhere.app.api.ApiClient
import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.apiPath
import org.json.JSONArray
import org.json.JSONObject

/** 加密模式下 Server 能看到的唯一一条命令信息：`POST /api/v3/e2ee/commands`。 */
data class CommandRegistrationResult(val duplicate: Boolean)

class E2eeApi(
    private val client: ApiClient = ApiClient(),
) {
    /** 发命令前登记 `CommandRegistration`；返回 `duplicate: true` 时这条命令已经发过，不要再发。 */
    fun registerCommand(
        serverUrl: String,
        authorizationToken: String,
        commandId: String,
        deviceId: String,
        inputDigest: String,
    ): CommandRegistrationResult {
        val response = client.postJson(
            serverUrl = serverUrl,
            path = "/api/v3/e2ee/commands",
            body = JSONObject().put("commandId", commandId).put("deviceId", deviceId).put("inputDigest", inputDigest),
            authorizationToken = authorizationToken,
        )
        return CommandRegistrationResult(duplicate = response.optBoolean("duplicate", false))
    }
}

/** 加密模式下 Server 拒绝内容路由的错误码：`409 {"detail": {"code": "e2ee_required"}}`。 */
fun ApiException.isE2eeRequired(): Boolean = errorCode == E2eeErrorCodes.E2EE_REQUIRED

/**
 * 经通道发一个普通模式的客户端 API 请求，返回 JSON 对象；非 2xx 转成 [ApiException]，
 * 与 [ApiClient] 的错误处理一致。`path` 可以写成普通模式下的相对路径（`/sessions/…`）。
 */
suspend fun ClientSecureChannel.requestJson(method: String, path: String, body: JSONObject? = null): JSONObject =
    request(method, apiPath(path), body?.toString()).toJsonObjectOrThrow()

fun TunnelResponse.toJsonObjectOrThrow(): JSONObject {
    if (!isSuccessful) {
        val detail = when (val raw = body) {
            is JSONObject -> raw.optJSONObject("detail") ?: raw
            else -> null
        }
        val code = detail?.optString("code")?.takeIf { it.isNotBlank() }
        val message = detail?.optString("message")?.takeIf { it.isNotBlank() }
            ?: (body as? JSONObject)?.optString("detail")?.takeIf { it.isNotBlank() }
            ?: code
            ?: "Request failed with status $status."
        throw ApiException(message = message, statusCode = status, errorCode = code)
    }
    return when (val raw = body) {
        is JSONObject -> raw
        null -> JSONObject()
        is JSONArray -> JSONObject().put("items", raw)
        else -> JSONObject().put("value", raw)
    }
}
