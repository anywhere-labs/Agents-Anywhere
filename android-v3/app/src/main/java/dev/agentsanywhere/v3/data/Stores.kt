package dev.agentsanywhere.v3.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import dev.agentsanywhere.v3.core.store.CacheStore
import dev.agentsanywhere.v3.core.store.SecureStore
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Secrets (tokens, the client's X25519 private key, device trust records) encrypted with AES-256-GCM under a key that
 * never leaves the Android Keystore. Each value has its own IV; the key alias is bound to this app.
 * `androidx.security:security-crypto` is deprecated, so this is the few lines it amounted to.
 */
class KeystoreSecureStore(context: Context) : SecureStore {
    private val prefs = context.getSharedPreferences("aa.secure", Context.MODE_PRIVATE)

    private val key: SecretKey by lazy {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build())
            generateKey()
        }
    }

    @Synchronized
    override fun get(key: String): String? {
        val stored = prefs.getString(key, null) ?: return null
        return try {
            val bytes = Base64.decode(stored, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, this.key, GCMParameterSpec(128, bytes, 0, IV))
            cipher.updateAAD(key.toByteArray())
            String(cipher.doFinal(bytes, IV, bytes.size - IV), Charsets.UTF_8)
        } catch (e: Exception) {
            // The Keystore key is gone (restored backup, cleared credentials): the value cannot be read any more.
            Log.w("AAv3", "secure value $key unreadable: ${e.javaClass.simpleName}")
            prefs.edit().remove(key).apply()
            null
        }
    }

    @Synchronized
    override fun put(key: String, value: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, this.key)
        cipher.updateAAD(key.toByteArray())
        val sealed = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        prefs.edit().putString(key, Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
    }

    @Synchronized
    override fun remove(key: String) {
        prefs.edit().remove(key).apply()
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "aa.v3.secure"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV = 12
    }
}

/** Offline cache files in app-private storage (`files/cache-v1/<key>.json`); not secrets. */
class FileCacheStore(context: Context) : CacheStore {
    private val dir = File(context.filesDir, "cache-v1").apply { mkdirs() }

    private fun file(key: String) = File(dir, key.replace(Regex("[^A-Za-z0-9._-]"), "_") + ".json")

    override fun read(key: String): String? = file(key).takeIf { it.exists() }?.readText()

    override fun write(key: String, value: String) {
        val target = file(key)
        val tmp = File(dir, target.name + ".tmp")
        tmp.writeText(value)
        tmp.renameTo(target)
    }

    override fun delete(key: String) {
        file(key).delete()
    }

    override fun clear() {
        dir.listFiles()?.forEach { it.delete() }
    }
}
