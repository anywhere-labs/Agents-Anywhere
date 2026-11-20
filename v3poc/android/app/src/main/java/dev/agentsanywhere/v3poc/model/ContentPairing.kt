package dev.agentsanywhere.v3poc.model

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import dev.agentsanywhere.v3poc.generated.ContentSubscribeRequest
import dev.agentsanywhere.v3poc.generated.ContentRequest
import io.github.t4wefan.meshcall.MeshCallException
import dev.agentsanywhere.v3poc.generated.ContentPairRequest
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.time.format.DateTimeParseException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.bouncycastle.math.ec.rfc7748.X25519

internal class ContentPairing(
    context: Context,
    private val server: HttpUrl,
    accountId: String,
    private val deviceId: String,
    private val invitation: String?,
    private val http: OkHttpClient,
    private val accessToken: suspend () -> String,
) {
    private val lock = Mutex()
    private val storage = PrivateContentStorage(context, listOf(server.toString(), accountId, deviceId).joinToString("\u0000"), ContentPairingRecord.serializer())
    private var active: PairedContent? = null

    suspend fun hasGrant(): Boolean = withContext(Dispatchers.IO) { storage.read()?.clientId != null }

    suspend fun connect(): PairedContent = lock.withLock {
        try {
            active ?: prepare().also { active = it }
        } catch (_: SerializationException) {
            // JSON diagnostics can contain the invitation or locally stored credential.
            throw DeviceGrantUnavailable()
        }
    }

    private suspend fun prepare(): PairedContent {
        val saved = withContext(Dispatchers.IO) { storage.read() }
        saved?.clientId?.takeIf { invitation.isNullOrBlank() }?.let { clientId ->
            return PairedContent(transport(saved.connectorKey), ContentAuthorization(clientId, saved.secret), saved.connectorKey)
        }

        val invite = PairingInvitation.parse(invitation)
        if (invite.deviceId != deviceId || invite.serverUrl.toHttpUrl() != server) throw PairingTargetMismatch()
        if (saved != null && saved.connectorKey != invite.deviceIdentityPub) throw DeviceIdentityMismatch()
        val transport = transport(invite.deviceIdentityPub)
        try {
            val existing = if (saved?.clientId != null) {
                // A fresh invitation must not reactivate credentials previously rejected by the computer.
                try {
                    val proof = transport.request(ContentRequest(null, "GET", "/e2ee/v1/directory-key"),
                        ContentAuthorization(saved.clientId, saved.secret))
                    check(proof.status == 200L)
                    saved
                } catch (_: ClientNoLongerAuthorized) {
                    null
                }
            } else saved
            val record = existing ?: newRecord(invite.deviceIdentityPub)
            val result = transport.pair(ContentPairRequest(
                clientIdentityPub = record.identity, clientSecret = record.secret, label = "Android",
                pairingId = invite.pairingId, pairingSecret = invite.psk, platform = "android",
            ))
            withContext(Dispatchers.IO) { storage.write(record.copy(clientId = result.clientId)) }
            return PairedContent(transport, ContentAuthorization(result.clientId, record.secret), record.connectorKey)
        } catch (failure: Exception) {
            withContext(NonCancellable) { transport.invalidate() }
            throw failure
        }
    }

    private suspend fun newRecord(pinnedKey: String): ContentPairingRecord =
        withContext(Dispatchers.IO) {
            val random = SecureRandom()
            val privateKey = ByteArray(32)
            val publicKey = ByteArray(32)
            X25519.generatePrivateKey(random, privateKey)
            X25519.generatePublicKey(privateKey, 0, publicKey, 0)
            privateKey.fill(0)
            val secret = ByteArray(32).also(random::nextBytes)
            ContentPairingRecord(pinnedKey, encode(publicKey), encode(secret)).also(storage::write)
        }

    /** The trust stream ends with e2ee_not_paired when this client's grant is revoked. */
    suspend fun awaitRevocation(peer: PairedContent) {
        var retryMs = 1000L
        while (true) {
            val monitor = transport(peer.connectorKey)
            try {
                monitor.subscribe(ContentSubscribeRequest(stream = "trust"), peer.authorization)
                    .collect { retryMs = 1000L }
            } catch (failure: MeshCallException) {
                if (failure.reason == "e2ee_not_paired") return
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // A lost connection cannot establish that authorization was revoked.
            } finally {
                withContext(NonCancellable) { monitor.invalidate() }
            }
            delay(retryMs)
            retryMs = (retryMs * 2).coerceAtMost(30_000L)
        }
    }

    suspend fun close() = lock.withLock {
        active?.transport?.invalidate()
        active = null
    }

    suspend fun forget() = lock.withLock {
        active?.transport?.invalidate()
        active = null
        withContext(Dispatchers.IO) { storage.remove() }
    }

    private fun transport(pinnedKey: String) = DeviceContentTransport(server, deviceId, pinnedKey, http, accessToken)
}

internal class PairingInvitationExpired : IllegalStateException()
internal class PairingTargetMismatch : IllegalArgumentException()

internal class PairedContent(val transport: DeviceContentTransport, val authorization: ContentAuthorization, val connectorKey: String)

@Serializable
internal class PairingInvitation(
    val v: Int,
    val deviceId: String,
    val deviceIdentityPub: String,
    val pairingId: String,
    val psk: String,
    val serverUrl: String,
    val e2eeMode: String,
    val expiresAt: String,
) {
    companion object {
        fun parse(uri: String?): PairingInvitation {
            val prefix = "aa-pair://"
            if (uri == null || !uri.startsWith(prefix)) throw DeviceGrantUnavailable()
            try {
                return AAJson.decodeFromString(serializer(), decode(uri.removePrefix(prefix)).decodeToString()).also {
                    if (it.v != 1 || it.e2eeMode != "required" || it.pairingId.isEmpty() ||
                        decode(it.deviceIdentityPub).size != 32 || decode(it.psk).size != 32) {
                        throw DeviceGrantUnavailable()
                    }
                    if (!Instant.parse(it.expiresAt).isAfter(Instant.now())) throw PairingInvitationExpired()
                }
            } catch (_: DateTimeParseException) {
                throw DeviceGrantUnavailable()
            } catch (_: IllegalArgumentException) {
                throw DeviceGrantUnavailable()
            }
        }
    }
}

@Serializable
private data class ContentPairingRecord(
    val connectorKey: String,
    val identity: String,
    val secret: String,
    val clientId: String? = null,
)

/** AES-GCM keeps the pairing record bound to this app installation and its account/device key. */
internal class PrivateContentStorage<T>(context: Context, scope: String, private val serializer: kotlinx.serialization.KSerializer<T>) {
    private val preferences = context.getSharedPreferences("meshcall-content-pairing", Context.MODE_PRIVATE)
    private val recordKey = encode(MessageDigest.getInstance("SHA-256").digest(scope.encodeToByteArray()))

    fun read(): T? {
        val stored = preferences.getString(recordKey, null) ?: return null
        val sealed = decode(stored)
        require(sealed.size > IV_SIZE) { "Invalid pairing record" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, IV_SIZE))
        cipher.updateAAD(recordKey.encodeToByteArray())
        val data = cipher.doFinal(sealed, IV_SIZE, sealed.size - IV_SIZE)
        return AAJson.decodeFromString(serializer, data.decodeToString())
    }

    fun write(record: T) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(recordKey.encodeToByteArray())
        val data = AAJson.encodeToString(serializer, record).encodeToByteArray()
        val completed = preferences.edit().putString(recordKey, encode(cipher.iv + cipher.doFinal(data))).commit()
        check(completed) { "Unable to store pairing record" }
    }

    fun remove() { check(preferences.edit().remove(recordKey).commit()) }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "agents-anywhere-meshcall-content"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_SIZE = 12

        @Synchronized
        fun key(): SecretKey {
            val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
            (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
            val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
            generator.init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build())
            return generator.generateKey()
        }
    }
}

private fun encode(data: ByteArray): String = Base64.encodeToString(data, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
private fun decode(value: String): ByteArray = Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP)
