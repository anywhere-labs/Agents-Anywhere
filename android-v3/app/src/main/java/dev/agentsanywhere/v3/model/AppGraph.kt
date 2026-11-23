package dev.agentsanywhere.v3.model

import android.content.Context
import dev.agentsanywhere.v3.core.api.ApiException
import dev.agentsanywhere.v3.core.api.AuthSession
import dev.agentsanywhere.v3.core.cache.OfflineCache
import dev.agentsanywhere.v3.core.mesh.AAException
import dev.agentsanywhere.v3.core.mesh.ControlMesh
import dev.agentsanywhere.v3.core.mesh.DeviceClient
import dev.agentsanywhere.v3.core.mesh.DeviceTunnelPool
import dev.agentsanywhere.v3.core.pairing.TrustStore
import dev.agentsanywhere.v3.core.store.ClientIdentity
import dev.agentsanywhere.v3.data.FileCacheStore
import dev.agentsanywhere.v3.data.KeystoreSecureStore
import io.github.t4wefan.meshcall.MeshCallException
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/** Process-wide services: secure storage, the account, the control Mesh, device tunnels, the offline cache. */
class AppGraph(context: Context) {
    val secure = KeystoreSecureStore(context)
    val identity: ClientIdentity = ClientIdentity.loadOrCreate(secure)
    val auth = AuthSession(secure, identity)
    /** One OkHttp client (dispatcher, connection pool) for every Mesh. */
    val http: OkHttpClient = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).build()
    val control = ControlMesh(auth, http)
    val trust = TrustStore(secure)
    val tunnels = DeviceTunnelPool(control, identity, trust, http)
    val cache = OfflineCache(FileCacheStore(context))

    fun device(deviceId: String) = DeviceClient(tunnels, deviceId)
}

/** A short, user-facing description of a failure. */
fun Throwable.userMessage(): String = when (this) {
    is AAException -> message ?: code
    is ApiException -> when (code) {
        "network" -> "无法连接控制面：${message}"
        "unauthenticated" -> "登录已失效，请重新登录"
        else -> message ?: code
    }
    is MeshCallException -> when {
        reason == "e2e_peer_required" || reason == "e2e_not_paired" -> "这台设备已加密，需要先扫码配对"
        code == "unavailable" -> "设备暂时无法连接（${message}）"
        code == "permission_denied" -> "没有权限：${message}"
        else -> message ?: code
    }
    is java.io.IOException -> "网络错误：${message}"
    else -> message ?: javaClass.simpleName
}
