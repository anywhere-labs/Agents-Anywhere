package com.agentsanywhere.app.feature.e2ee

import com.agentsanywhere.app.api.RemoteDisplayEnvelope
import com.agentsanywhere.app.api.e2ee.DirectoryKeyGrant
import com.agentsanywhere.app.api.e2ee.DisplaySlot
import com.agentsanywhere.app.api.e2ee.E2eeFormats
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/** 展示信封里认识的明文字段（`displayDevice` 是 `{title?, cwd?, preview?}`，`displayUser` 是 `{title}`）；其余字段忽略。 */
data class DisplayFields(
    val title: String? = null,
    val cwd: String? = null,
    val preview: String? = null,
) {
    companion object {
        /** 明文 JSON；不是对象时返回 null。 */
        fun parse(json: String): DisplayFields? {
            val value = runCatching { JSONObject(json) }.getOrNull() ?: return null
            fun text(name: String): String? = (value.opt(name) as? String)?.takeIf { it.isNotBlank() }
            return DisplayFields(title = text("title"), cwd = text("cwd"), preview = text("preview"))
        }
    }
}

/** 打开一个展示信封的结果。 */
sealed interface DisplayOpenResult {
    data class Opened(val fields: DisplayFields) : DisplayOpenResult

    /** 没有 `keyId` 对应的密钥（未配对、旧纪元）或解不开：显示「加密中」占位。 */
    data object Locked : DisplayOpenResult
}

/**
 * 解开会话列表里的展示信封（contracts/e2ee/1.0「加密的存放内容」）。
 *
 * - AD 绑定 `(设备 = 会话的 connectorId, 会话 ID, slot, keyId)`；`displayDevice` 用 [DisplaySlot.Device]，`displayUser` 用 [DisplaySlot.User]。
 * - 本机只保存设备当前纪元的列表密钥：信封的 `keyId` 与它不同就是 [DisplayOpenResult.Locked]。
 * - 结果按 `(sessionId, slot, keyId, payload)` 缓存在内存；[revision] 变化（配对、轮换、撤销）时清空重试。
 */
class SessionDisplayDecryptor(
    private val keyFor: (deviceId: String) -> DirectoryKeyGrant?,
    private val revision: () -> Long = { 0L },
) {
    private data class CacheKey(val sessionId: String, val slot: DisplaySlot, val keyId: String, val payload: String)

    private val cache = ConcurrentHashMap<CacheKey, DisplayOpenResult>()
    private val keys = ConcurrentHashMap<String, KeyLookup>()
    private val revisionLock = Any()

    @Volatile
    private var seenRevision: Long? = null

    /** `null` 表示这台设备没有密钥（缓存「没有」，免得每一行都去 Keystore 解包）。 */
    private data class KeyLookup(val grant: DirectoryKeyGrant?)

    fun open(deviceId: String, sessionId: String, slot: DisplaySlot, envelope: RemoteDisplayEnvelope): DisplayOpenResult {
        if (envelope.isPlain) return DisplayOpenResult.Opened(DisplayFields.parse(envelope.payload) ?: DisplayFields())
        if (envelope.mode != RemoteDisplayEnvelope.MODE_SEALED) return DisplayOpenResult.Locked
        val keyId = envelope.keyId?.takeIf { it.isNotBlank() } ?: return DisplayOpenResult.Locked
        syncRevision()
        val cacheKey = CacheKey(sessionId, slot, keyId, envelope.payload)
        cache[cacheKey]?.let { return it }
        val result = decrypt(deviceId, sessionId, slot, keyId, envelope.payload)
        if (cache.size >= MAX_CACHE_ENTRIES) cache.clear()
        cache[cacheKey] = result
        return result
    }

    /** 清掉缓存（重新登录、退出登录时）；下次打开时重新查密钥、重新解密。 */
    fun invalidate() {
        cache.clear()
        keys.clear()
    }

    private fun decrypt(deviceId: String, sessionId: String, slot: DisplaySlot, keyId: String, payload: String): DisplayOpenResult {
        if (deviceId.isBlank()) return DisplayOpenResult.Locked
        val grant = keys.getOrPut(deviceId) { KeyLookup(runCatching { keyFor(deviceId) }.getOrNull()) }.grant
            ?: return DisplayOpenResult.Locked
        if (grant.keyId != keyId) return DisplayOpenResult.Locked
        val json = runCatching {
            E2eeFormats.openDisplayEnvelope(grant.keyBytes, deviceId, sessionId, slot, keyId, payload)
        }.getOrNull() ?: return DisplayOpenResult.Locked
        return DisplayFields.parse(json)?.let { DisplayOpenResult.Opened(it) } ?: DisplayOpenResult.Locked
    }

    private fun syncRevision() {
        val current = runCatching(revision).getOrNull() ?: return
        if (seenRevision == current) return
        synchronized(revisionLock) {
            if (seenRevision == current) return
            invalidate()
            seenRevision = current
        }
    }

    private companion object {
        const val MAX_CACHE_ENTRIES = 4096
    }
}
