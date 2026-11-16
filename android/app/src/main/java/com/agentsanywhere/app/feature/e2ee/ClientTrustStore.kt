package com.agentsanywhere.app.feature.e2ee

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.agentsanywhere.app.api.e2ee.DirectoryKeyGrant
import com.agentsanywhere.app.api.e2ee.E2eeFormats
import com.agentsanywhere.app.api.e2ee.noise.NoiseCrypto
import com.agentsanywhere.app.api.e2ee.noise.X25519KeyPair
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Client Trust：本机的客户端身份密钥、每台设备钉住的公钥与列表密钥、本机的「该设备要求加密」策略。
 *
 * 私密数据（X25519 身份私钥、列表密钥）用 [SecretSealer] 包裹后才写进存储。Android 上是
 * Android Keystore 里一把不可导出的 AES-256-GCM 密钥（[KeystoreSecretSealer]）：
 * minSdk 26 的 Keystore 不支持 X25519（API 31 起才有），Noise 的 DH 又必须在进程里用 noise-java 做，
 * 所以身份私钥只能「Keystore 包裹 + 进程内使用」。这和 `EncryptedSharedPreferences` 的做法相同，
 * 但不需要再加 androidx.security 依赖（它已停止维护）。
 *
 * 降级保护（E-3）：[markEncryptionRequired] 一旦记下，只有本地操作能清除；Server 的配置改成 off、
 * 设备撤销授权、重新配对都不会清除它。
 */
class ClientTrustStore(
    private val storage: TrustStorage,
    private val sealer: SecretSealer,
    private val generateKeyPair: () -> X25519KeyPair = NoiseCrypto::generateKeyPair,
) {
    private val lock = Any()
    private var cachedIdentity: X25519KeyPair? = null

    /** 本机的客户端身份；第一次调用时生成。Keystore 密钥丢失（例如恢复到另一台手机）时重新生成，原有配对作废。 */
    fun identity(): X25519KeyPair = synchronized(lock) {
        cachedIdentity?.let { return it }
        val stored = storage.read(KEY_IDENTITY)?.let { sealed ->
            runCatching { X25519KeyPair.fromSecret(sealer.open(E2eeFormats.fromB64url(sealed))) }.getOrNull()
        }
        val identity = stored ?: createIdentityLocked()
        cachedIdentity = identity
        identity
    }

    fun clientId(): String = E2eeFormats.clientIdFor(identity().publicKey)

    fun clientFingerprint(): String = E2eeFormats.fingerprint(identity().publicKey)

    fun device(deviceId: String): PairedDevice? = synchronized(lock) {
        storage.read(deviceKey(deviceId))?.let { runCatching { PairedDevice.fromJson(JSONObject(it)) }.getOrNull() }
            ?.takeIf { it.clientId == clientId() }
    }

    fun isPaired(deviceId: String): Boolean = device(deviceId) != null

    /** 配对成功（收到 `pair.committed`）后保存授权与列表密钥，并记下「该设备要求加密」。 */
    fun savePairing(deviceId: String, devicePub: ByteArray, grantedAt: String, directoryKey: DirectoryKeyGrant): PairedDevice {
        require(directoryKey.deviceId == deviceId) { "directory key belongs to another device" }
        val record = PairedDevice(
            deviceId = deviceId,
            clientId = clientId(),
            devicePub = E2eeFormats.b64url(devicePub),
            deviceFingerprint = E2eeFormats.fingerprint(devicePub),
            grantedAt = grantedAt,
            directoryKeyId = directoryKey.keyId,
            directoryKeyEpoch = directoryKey.epoch,
        )
        synchronized(lock) {
            storage.write(deviceKey(deviceId), record.toJson().toString())
            storage.write(directoryKeyKey(deviceId), E2eeFormats.b64url(sealer.seal(directoryKey.keyBytes)))
            storage.write(requireKey(deviceId), "1")
        }
        return record
    }

    /** 当前的列表密钥；没有配对或无法解开时返回 null。 */
    fun directoryKey(deviceId: String): DirectoryKeyGrant? {
        val record = device(deviceId) ?: return null
        val sealed = synchronized(lock) { storage.read(directoryKeyKey(deviceId)) } ?: return null
        val key = runCatching { sealer.open(E2eeFormats.fromB64url(sealed)) }.getOrNull() ?: return null
        return DirectoryKeyGrant(deviceId, record.directoryKeyId, record.directoryKeyEpoch, E2eeFormats.b64url(key))
    }

    /** 设备轮换了列表密钥（`e2ee.directory_key` 或 `GET /e2ee/v1/directory-key`）。旧纪元不覆盖新纪元。 */
    fun updateDirectoryKey(grant: DirectoryKeyGrant): Boolean = synchronized(lock) {
        val record = device(grant.deviceId) ?: return false
        if (grant.epoch < record.directoryKeyEpoch) return false
        storage.write(directoryKeyKey(grant.deviceId), E2eeFormats.b64url(sealer.seal(grant.keyBytes)))
        storage.write(deviceKey(grant.deviceId), record.copy(directoryKeyId = grant.keyId, directoryKeyEpoch = grant.epoch).toJson().toString())
        true
    }

    /** 设备撤销了本机（KK 收到 `e2ee_not_paired`）：删掉钉住的公钥与列表密钥，但保留「要求加密」。 */
    fun forgetPairing(deviceId: String) = synchronized(lock) {
        storage.write(deviceKey(deviceId), null)
        storage.write(directoryKeyKey(deviceId), null)
    }

    fun markEncryptionRequired(deviceId: String) = synchronized(lock) { storage.write(requireKey(deviceId), "1") }

    fun requiresEncryption(deviceId: String): Boolean = synchronized(lock) { storage.read(requireKey(deviceId)) == "1" }

    private fun createIdentityLocked(): X25519KeyPair {
        val identity = generateKeyPair()
        val secret = identity.secretKey()
        try {
            storage.write(KEY_IDENTITY, E2eeFormats.b64url(sealer.seal(secret)))
        } finally {
            secret.fill(0)
        }
        return identity
    }

    private fun deviceKey(deviceId: String) = "device.$deviceId"
    private fun directoryKeyKey(deviceId: String) = "directory_key.$deviceId"
    private fun requireKey(deviceId: String) = "require.$deviceId"

    companion object {
        private const val KEY_IDENTITY = "identity"
        const val PREFERENCES_NAME = "agents_anywhere_e2ee"

        fun create(context: Context): ClientTrustStore = ClientTrustStore(
            storage = SharedPreferencesTrustStorage(context),
            sealer = KeystoreSecretSealer(),
        )
    }
}

/** 一台已配对的设备：钉住的公钥、授权时间、当前列表密钥的 keyId 与纪元。 */
data class PairedDevice(
    val deviceId: String,
    val clientId: String,
    val devicePub: String,
    val deviceFingerprint: String,
    val grantedAt: String,
    val directoryKeyId: String,
    val directoryKeyEpoch: Long,
) {
    val devicePubBytes: ByteArray get() = E2eeFormats.fromB64url(devicePub)

    fun toJson(): JSONObject = JSONObject()
        .put("deviceId", deviceId)
        .put("clientId", clientId)
        .put("devicePub", devicePub)
        .put("deviceFingerprint", deviceFingerprint)
        .put("grantedAt", grantedAt)
        .put("directoryKeyId", directoryKeyId)
        .put("directoryKeyEpoch", directoryKeyEpoch)

    companion object {
        fun fromJson(json: JSONObject) = PairedDevice(
            deviceId = json.getString("deviceId"),
            clientId = json.getString("clientId"),
            devicePub = json.getString("devicePub"),
            deviceFingerprint = json.getString("deviceFingerprint"),
            grantedAt = json.getString("grantedAt"),
            directoryKeyId = json.getString("directoryKeyId"),
            directoryKeyEpoch = json.getLong("directoryKeyEpoch"),
        )
    }
}

/** 小键值存储；写 null 表示删除。 */
interface TrustStorage {
    fun read(name: String): String?
    fun write(name: String, value: String?)
}

class SharedPreferencesTrustStorage(context: Context) : TrustStorage {
    private val preferences = context.applicationContext.getSharedPreferences(ClientTrustStore.PREFERENCES_NAME, Context.MODE_PRIVATE)

    override fun read(name: String): String? = preferences.getString(name, null)

    // commit() rather than apply(): a pairing must be on disk before the UI says it succeeded.
    override fun write(name: String, value: String?) {
        preferences.edit().apply { if (value == null) remove(name) else putString(name, value) }.commit()
    }
}

class InMemoryTrustStorage : TrustStorage {
    private val values = java.util.concurrent.ConcurrentHashMap<String, String>()
    override fun read(name: String): String? = values[name]
    override fun write(name: String, value: String?) {
        if (value == null) values.remove(name) else values[name] = value
    }
}

/** 包裹本地私密数据。 */
interface SecretSealer {
    fun seal(plaintext: ByteArray): ByteArray
    fun open(sealed: ByteArray): ByteArray
}

/** Android Keystore 里一把不可导出的 AES-256-GCM 密钥；输出 `iv(12) ‖ 密文`。 */
class KeystoreSecretSealer(private val alias: String = "agents_anywhere_e2ee_wrap") : SecretSealer {
    override fun seal(plaintext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        return cipher.iv + cipher.doFinal(plaintext)
    }

    override fun open(sealed: ByteArray): ByteArray {
        require(sealed.size > IV_BYTES) { "sealed secret too short" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, IV_BYTES))
        return cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
    }

    @Synchronized
    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
    }
}
