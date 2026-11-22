package dev.agentsanywhere.v3.core.api

import dev.agentsanywhere.v3.core.model.AuthTokenResponse
import dev.agentsanywhere.v3.core.model.UserView
import dev.agentsanywhere.v3.core.store.ClientIdentity
import dev.agentsanywhere.v3.core.store.SecureStore
import dev.agentsanywhere.v3.core.store.StoredAuth
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The account's tokens. The refresh token rotates on every use (the old one is revoked), so refreshes are serialized:
 * concurrent callers wait for the one in flight and reuse its result. A refresh that the server rejects signs out.
 */
class AuthSession(
    private val store: SecureStore,
    val identity: ClientIdentity,
    private val clock: () -> Long = System::currentTimeMillis,
    private val httpFactory: (String) -> ControlHttpClient = { ControlHttpClient(it) },
) {
    private val mutex = Mutex()
    private val _auth = MutableStateFlow(StoredAuth.load(store))
    val auth: StateFlow<StoredAuth?> = _auth
    val signedIn: Boolean get() = _auth.value != null
    val user: UserView? get() = _auth.value?.user

    private var httpCache: ControlHttpClient? = null
    fun http(): ControlHttpClient {
        val url = _auth.value?.control_url ?: throw ApiException(401, "unauthenticated", "Not signed in")
        return httpCache?.takeIf { it.baseUrl == url } ?: httpFactory(url).also { httpCache = it }
    }

    suspend fun signIn(controlUrl: String, email: String, password: String): StoredAuth {
        val http = httpFactory(controlUrl)
        val response = http.login(email, password, identity.client_id)
        val auth = toStored(http.baseUrl, response)
        mutex.withLock { persist(auth) }
        httpCache = http
        return auth
    }

    suspend fun signOut() {
        val current = _auth.value ?: return
        runCatching { http().logout(current.refresh_token) }
        mutex.withLock { persist(null) }
    }

    /** A valid access token, refreshed when less than 60 s remain. */
    suspend fun accessToken(): String {
        _auth.value?.let { if (it.expires_at - clock() > 60_000) return it.access_token }
        return refresh(force = false)
    }

    /** Refreshes now (after a 401); [force] skips the expiry check. */
    suspend fun refresh(force: Boolean = true): String = mutex.withLock {
        val current = _auth.value ?: throw ApiException(401, "unauthenticated", "Not signed in")
        if (!force && current.expires_at - clock() > 60_000) return current.access_token
        val refreshed = try {
            http().refresh(current.refresh_token)
        } catch (e: ApiException) {
            if (e.unauthenticated || e.status == 400 || e.code == "invalid_argument") persist(null)
            throw e
        }
        val next = toStored(current.control_url, refreshed)
        persist(next)
        next.access_token
    }

    /** Runs [block] with an access token, refreshing once and retrying if the server answers 401. */
    suspend fun <T> authorized(block: suspend (ControlHttpClient, String) -> T): T {
        val token = accessToken()
        return try {
            block(http(), token)
        } catch (e: ApiException) {
            if (!e.unauthenticated) throw e
            block(http(), refresh(force = true))
        }
    }

    fun updateUser(user: UserView) {
        _auth.value?.let { persist(it.copy(user = user)) }
    }

    private fun toStored(controlUrl: String, r: AuthTokenResponse) =
        StoredAuth(controlUrl, r.access_token, r.refresh_token, clock() + r.expires_in * 1000, r.user)

    private fun persist(value: StoredAuth?) {
        StoredAuth.save(store, value)
        _auth.value = value
    }
}
