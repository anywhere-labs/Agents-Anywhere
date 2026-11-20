package dev.agentsanywhere.v3poc.model

import android.content.Context
import android.net.Uri
import dev.agentsanywhere.v3poc.BuildConfig
import dev.agentsanywhere.v3poc.R
import dev.agentsanywhere.v3poc.generated.ContentRequest
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

@Serializable
internal data class NativeLogin(
    val userId: String,
    val displayName: String = "",
    val email: String? = null,
    val accessToken: String,
    val expiresAt: String,
    val refreshToken: String,
)

@Serializable
private data class SavedLogin(val server: String, val credentials: NativeLogin, val device: String? = null)

internal class AccountRequestFailed(val status: Int) : Exception()
internal class InvalidServer : IllegalArgumentException()

internal class NativeAccount(private val context: Context) {
    private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).build()
    private val storage = PrivateContentStorage(context, "native-account", SavedLogin.serializer())
    private val lock = Mutex()
    private var login: SavedLogin? = null

    suspend fun restore(): Boolean = lock.withLock {
        login = withContext(Dispatchers.IO) { storage.read() }
        login != null
    }

    suspend fun signIn(address: String, email: String, password: String) = lock.withLock {
        val server = parseServer(address)
        val normalized = email.trim().lowercase()
        val salt = call(server, "auth/password-salt", jsObj("email" to normalized))["salt"].str
            ?: throw AccountRequestFailed(502)
        val verifier = withContext(Dispatchers.Default) {
            val spec = javax.crypto.spec.PBEKeySpec(password.toCharArray(), salt.encodeToByteArray(), 120_000, 256)
            try {
                val bytes = javax.crypto.SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
                java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
            } finally {
                spec.clearPassword()
            }
        }
        val tokens = try {
            call(server, "auth/login", jsObj("email" to normalized, "passwordVerifier" to verifier))
        } catch (failure: AccountRequestFailed) {
            if (failure.status != 401) throw failure
            // Accounts created with the legacy password API still use the server-side password hash.
            call(server, "auth/login", jsObj("email" to normalized, "password" to password))
        }
        val credentials = AAJson.decodeFromJsonElement(NativeLogin.serializer(), tokens)
        save(SavedLogin(server.toString(), credentials))
    }

    suspend fun devices(): Pair<List<Workspace.Device>, String?> {
        val current = saved()
        val devices = directory("devices")["connectors"].arr.orEmpty().mapNotNull { value ->
            val id = value["id"].str ?: return@mapNotNull null
            Workspace.Device(id, value["name"].str.orEmpty(), value["status"].str.orEmpty(), value["deviceOs"].str.orEmpty())
        }
        return devices to current.device
    }

    suspend fun open(device: Workspace.Device, invitation: String?): OnlineWorkspace {
        val current = saved()
        val account = current.credentials
        val pairing = ContentPairing(context, parseServer(current.server), account.userId, device.id, invitation, http, ::accessToken)
        try {
            val peer = pairing.connect()
            val keyResult = peer.transport.request(ContentRequest(null, "GET", "/e2ee/v1/directory-key"), peer.authorization)
            if (keyResult.status != 200L) throw AccountRequestFailed(keyResult.status.toInt())
            val key = keyResult.body
            val projects = directory("projects")["projects"].arr.orEmpty().mapNotNull { value ->
                if (value["connectorId"].str != device.id) return@mapNotNull null
                val cwd = value["workspacePath"].str ?: return@mapNotNull null
                Workspace.Project(device.id, cwd, value["name"].str.orEmpty(), value["id"].str)
            }
            val runtimes = directory("runtimes", deviceId = device.id)["runtimes"].arr.orEmpty().mapNotNull { value ->
                if (value["active"].bool != true || value["available"].bool != true) return@mapNotNull null
                val id = value["runtimeId"].str ?: return@mapNotNull null
                val type = value["runtimeType"].str ?: return@mapNotNull null
                RuntimeChoice(id, type, value["name"].str ?: type)
            }
            val sessions = mutableListOf<Workspace.Session>()
            var cursor: String? = null
            do {
                val page = directory("sessions", cursor = cursor)
                for (value in page["sessions"].arr.orEmpty()) {
                    if (value["connectorId"].str != device.id) continue
                    val id = value["id"].str ?: continue
                    val owned = openDisplay(value["displayDevice"], key, device.id, id, "device")
                    val renamed = openDisplay(value["displayUser"], key, device.id, id, "user")
                    val renameLocked = value["displayUser"]["mode"].str == "sealed" && renamed == null
                    val deviceLocked = value["displayDevice"]["mode"].str == "sealed" && owned == null
                    val title = if (renameLocked) null else
                        renamed["title"].str?.takeIf { it.isNotBlank() } ?: owned["title"].str?.takeIf { it.isNotBlank() }
                    val fallbackTitle = if (renameLocked || deviceLocked) R.string.connection_encrypted_session
                        else R.string.connection_untitled_session
                    sessions += Workspace.Session(
                        id, title ?: context.getString(fallbackTitle),
                        value["runtimeType"].str ?: value["runtime"].str.orEmpty(), device.id,
                        owned["cwd"].str.orEmpty(), value["status"].str.orEmpty(), value["unread"].bool ?: false,
                        value["pinned"].bool ?: false, value["lastActivityAt"].str.orEmpty(),
                    )
                }
                val next = page["nextCursor"].str
                if (next != null && next == cursor) throw AccountRequestFailed(502)
                cursor = next.takeIf { page["hasMore"].bool == true }
            } while (cursor != null)
            lock.withLock { save(checkNotNull(login).copy(device = device.id)) }
            val email = account.email.orEmpty()
            val workspace = Workspace(Workspace.Account(account.displayName.ifBlank { email }, email), listOf(device), projects, sessions)
            return OnlineWorkspace(workspace, MeshSessionsClient(device, sessions.associate { it.id to it.title }, runtimes, ::stageAttachment, mapOf(
                "model" to context.getString(R.string.connection_model),
                "permission" to context.getString(R.string.connection_permission),
            ), { code ->
                context.getString(if (code == "runtime_unavailable") R.string.connection_agent_unavailable else R.string.connection_delivery_failed)
            }, pairing::connect), pairing::close)
        } catch (failure: Exception) {
            withContext(NonCancellable) { pairing.close() }
            throw failure
        }
    }

    suspend fun forgetPairing(device: Workspace.Device) {
        val current = saved()
        ContentPairing(context, parseServer(current.server), current.credentials.userId, device.id, null, http, ::accessToken)
            .forget()
        lock.withLock {
            val value = login
            if (value != null && value.device == device.id) save(value.copy(device = null))
        }
    }

    private suspend fun stageAttachment(sessionId: String, uri: Uri): StagedAttachment {
        val current = saved()
        val token = accessToken()
        return withContext(Dispatchers.IO) {
            val file = SealedChatFile.read(context, uri)
            val url = checkNotNull(parseServer(current.server).resolve("api/v2/sessions/${Uri.encode(sessionId)}/attachments"))
            val request = Request.Builder().url(url).header("Authorization", "Bearer $token")
                .header("x-aa-sealed", "segments-v1").post(file.multipart()).build()
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) throw AccountRequestFailed(response.code)
                val data = AAJson.decodeFromString(JsonObject.serializer(), response.body.string())
                val reference = data["attachments"].arr?.singleOrNull() as? JsonObject ?: throw AccountRequestFailed(502)
                file.staged(reference)
            }
        }
    }

    suspend fun signOut() {
        try {
            val current = saved()
            call(parseServer(current.server), "auth/logout", jsObj(), accessToken())
        } finally {
            lock.withLock {
                withContext(NonCancellable + Dispatchers.IO) { storage.remove() }
                login = null
            }
        }
    }

    private suspend fun saved(): SavedLogin = lock.withLock { login ?: throw AccountRequestFailed(401) }

    private suspend fun accessToken(): String = lock.withLock {
        val current = login ?: throw AccountRequestFailed(401)
        if (Instant.parse(current.credentials.expiresAt).isAfter(Instant.now().plusSeconds(30))) {
            return@withLock current.credentials.accessToken
        }
        val data = call(parseServer(current.server), "auth/refresh", jsObj("refreshToken" to current.credentials.refreshToken))
        val next = AAJson.decodeFromJsonElement(NativeLogin.serializer(), data)
        if (next.userId != current.credentials.userId) throw AccountRequestFailed(401)
        save(current.copy(credentials = next))
        next.accessToken
    }

    private suspend fun save(value: SavedLogin) {
        withContext(NonCancellable + Dispatchers.IO) { storage.write(value) }
        login = value
    }

    private suspend fun directory(resource: String, deviceId: String? = null, cursor: String? = null): JsonObject {
        val current = saved()
        return withMobileControl(parseServer(current.server), http, ::accessToken) { control, instance ->
            control.readDirectory(instance, cursor = cursor, deviceId = deviceId, resource = resource).body
        }
    }

    private suspend fun call(server: HttpUrl, route: String, body: JsonObject? = null, token: String? = null): JsonObject =
        withContext(Dispatchers.IO) {
            val url = checkNotNull(server.resolve("api/v2/$route"))
            val request = Request.Builder().url(url)
            token?.let { request.header("Authorization", "Bearer $it") }
            body?.let { request.post(it.toString().toRequestBody("application/json".toMediaType())) }
            http.newCall(request.build()).execute().use { response ->
                if (!response.isSuccessful) throw AccountRequestFailed(response.code)
                if (response.code == 204) jsObj()
                else AAJson.decodeFromString(JsonObject.serializer(), response.body.string())
            }
        }

    private fun parseServer(raw: String): HttpUrl {
        val url = raw.trim().toHttpUrlOrNull() ?: throw InvalidServer()
        val loopback = url.host in setOf("localhost", "127.0.0.1", "::1", "10.0.2.2")
        if ((!url.isHttps && !(BuildConfig.DEBUG && loopback)) || url.encodedPath != "/" ||
            url.username.isNotEmpty() || url.password.isNotEmpty() || url.query != null || url.fragment != null) {
            throw InvalidServer()
        }
        return url
    }
}

internal class OnlineWorkspace(val workspace: Workspace, val client: SessionsClient, val close: suspend () -> Unit)

private fun openDisplay(value: kotlinx.serialization.json.JsonElement?, grant: kotlinx.serialization.json.JsonElement?,
                        device: String, session: String, slot: String): JsonObject? = runCatching {
    if (value["mode"].str != "sealed" || value["keyId"].str != grant["keyId"].str) return null
    val keyId = value["keyId"].str ?: return null
    val decoder = java.util.Base64.getUrlDecoder()
    val sealed = decoder.decode(value["payload"].str ?: return null)
    val key = javax.crypto.spec.SecretKeySpec(decoder.decode(grant["key"].str ?: return null), "AES")
    val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(javax.crypto.Cipher.DECRYPT_MODE, key, javax.crypto.spec.GCMParameterSpec(128, sealed, 0, 12))
    cipher.updateAAD(listOf("aa-e2ee/1.0", "display", device, session, slot, keyId).joinToString("\u0000").encodeToByteArray())
    AAJson.decodeFromString(JsonObject.serializer(), cipher.doFinal(sealed, 12, sealed.size - 12).decodeToString())
}.getOrNull()
