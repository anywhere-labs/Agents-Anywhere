package com.agentsanywhere.app.api.e2ee

import org.json.JSONObject

/** 设备二维码里的内容：`aa-pair://<base64url(PairingPayload)>`。 */
data class PairingPayload(
    val v: Int,
    val deviceId: String,
    val deviceIdentityPub: String,
    val pairingId: String,
    val psk: String,
    val serverUrl: String,
    val e2eeMode: String,
    val expiresAt: String,
) {
    val deviceIdentityPubBytes: ByteArray get() = E2eeFormats.fromB64url(deviceIdentityPub)
    val pskBytes: ByteArray get() = E2eeFormats.fromB64url(psk)

    /** 人工比对用的设备指纹。 */
    val deviceFingerprint: String get() = E2eeFormats.fingerprint(deviceIdentityPubBytes)

    fun toJson(): JSONObject = JSONObject()
        .put("v", v)
        .put("deviceId", deviceId)
        .put("deviceIdentityPub", deviceIdentityPub)
        .put("pairingId", pairingId)
        .put("psk", psk)
        .put("serverUrl", serverUrl)
        .put("e2eeMode", e2eeMode)
        .put("expiresAt", expiresAt)

    companion object {
        const val URI_PREFIX = "aa-pair://"
    }
}

class InvalidPairingUriException(message: String) : Exception(message)

/** 解析 `aa-pair://…`；格式不对抛 [InvalidPairingUriException]。 */
fun parsePairingUri(uri: String): PairingPayload {
    val text = uri.trim()
    if (!text.startsWith(PairingPayload.URI_PREFIX)) throw InvalidPairingUriException("not an aa-pair:// URI")
    val json = try {
        JSONObject(E2eeFormats.fromB64url(text.removePrefix(PairingPayload.URI_PREFIX)).toString(Charsets.UTF_8))
    } catch (_: Exception) {
        throw InvalidPairingUriException("malformed pairing payload")
    }
    fun field(name: String): String = json.optString(name).takeIf { json.has(name) && !json.isNull(name) && it.isNotEmpty() }
        ?: throw InvalidPairingUriException("pairing payload is missing $name")
    val payload = PairingPayload(
        v = json.optInt("v", 0),
        deviceId = field("deviceId"),
        deviceIdentityPub = field("deviceIdentityPub"),
        pairingId = field("pairingId"),
        psk = field("psk"),
        serverUrl = field("serverUrl"),
        e2eeMode = field("e2eeMode"),
        expiresAt = field("expiresAt"),
    )
    val validKeys = runCatching { payload.deviceIdentityPubBytes.size == 32 && payload.pskBytes.size == 32 }.getOrDefault(false)
    if (payload.v != 1 || !validKeys || (payload.e2eeMode != "off" && payload.e2eeMode != "required")) {
        throw InvalidPairingUriException("malformed pairing payload")
    }
    return payload
}
