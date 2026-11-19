package dev.agentsanywhere.v3poc.model

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.JsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody

internal data class StagedAttachment(val reference: JsonObject, val key: JsonObject)

internal class SealedChatFile(
    private val name: String,
    private val type: String,
    private val size: Int,
    private val digest: String,
    private val key: ByteArray,
    private val sealed: ByteArray,
) {
    fun multipart(): MultipartBody = MultipartBody.Builder().setType(MultipartBody.FORM)
        .addFormDataPart("files", "attachment.bin", sealed.toRequestBody("application/octet-stream".toMediaType())).build()

    fun staged(reference: JsonObject): StagedAttachment {
        val id = reference["fileId"].str ?: throw AccountRequestFailed(502)
        return StagedAttachment(reference, jsObj(
            "fileId" to id, "name" to name, "mimeType" to type, "size" to size, "sha256" to digest,
            "key" to Base64.getUrlEncoder().withoutPadding().encodeToString(key),
        ))
    }

    companion object {
        private const val chunkBytes = 64 * 1024
        private const val maxBytes = 25 * 1024 * 1024

        fun read(context: Context, uri: Uri): SealedChatFile {
            val resolver = context.contentResolver
            val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                if (it.moveToFirst()) it.getString(0) else null
            } ?: "attachment"
            val type = resolver.getType(uri) ?: "application/octet-stream"
            val plain = resolver.openInputStream(uri)?.use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(chunkBytes)
                while (true) {
                    val got = input.read(buffer)
                    if (got < 0) break
                    require(output.size() + got <= maxBytes)
                    output.write(buffer, 0, got)
                }
                output.toByteArray()
            } ?: error("Attachment unavailable")
            require(plain.isNotEmpty())
            try {
                val sha256 = MessageDigest.getInstance("SHA-256").digest(plain).joinToString("") { "%02x".format(it) }
                val key = ByteArray(32).also(SecureRandom()::nextBytes)
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                val parts = (plain.size + chunkBytes - 1) / chunkBytes
                val ciphertext = ByteArrayOutputStream(plain.size + 16 * parts)
                for (index in 0 until parts) {
                    val offset = index * chunkBytes
                    val nonce = ByteBuffer.allocate(12).putInt(0).putLong(index.toLong()).array()
                    val label = listOf("aa-e2ee/1.0", "attachment", sha256, index.toString()).joinToString("\u0000")
                    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
                    cipher.updateAAD(label.encodeToByteArray() + byteArrayOf(0, if (index == parts - 1) 1 else 0))
                    ciphertext.write(cipher.doFinal(plain, offset, minOf(chunkBytes, plain.size - offset)))
                }
                return SealedChatFile(name, type, plain.size, sha256, key, ciphertext.toByteArray())
            } finally {
                plain.fill(0)
            }
        }
    }
}
