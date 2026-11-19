package com.agentsanywhere.app.feature.e2ee

import com.agentsanywhere.app.api.e2ee.*
import java.time.Instant

/** In-process fixture for existing transport-policy and storage regressions. */
internal class LegacyE2eeProvider(
    private val trust: ClientTrustStore,
    private val tunnel: TunnelConnection,
    private val now: () -> Long = { 0L },
) : DeviceChannelProvider {
    override suspend fun pair(payload: PairingPayload, label: String, appVersion: String?): ChannelPair {
        if (isExpired(payload)) throw ChannelClosedException(E2eeErrorCodes.PAIRING_EXPIRED)
        val identity = trust.identity()
        val ch = ClientSecureChannel.newChannelId()
        val binding = ChannelBinding()
        val wire = tunnel.open(TunnelRoute(payload.deviceId, E2eeFormats.clientIdFor(identity.publicKey), ch), binding)
        val result = try {
            ClientSecureChannel.pair(payload, identity, ch, wire, label, "android", appVersion, now, binding::bind)
        } catch (error: ChannelClosedException) {
            if (error.code in NOT_RECOVERABLE) throw error
            // pair.committed 丢了：KK 能成功就说明授权已经写入（契约「通道的建立」）。
            return recoverPairing(payload) ?: throw error
        }
        return ChannelPair(result.channel, result.grantedAt, result.directoryKey)
    }

    override suspend fun open(deviceId: String, devicePub: ByteArray): DeviceContentChannel =
        connect(deviceId, devicePub).also { syncDirectoryKey(it) }

    private suspend fun connect(deviceId: String, devicePub: ByteArray): ClientSecureChannel {
        val identity = trust.identity()
        val ch = ClientSecureChannel.newChannelId()
        val binding = ChannelBinding()
        val wire = tunnel.open(TunnelRoute(deviceId, E2eeFormats.clientIdFor(identity.publicKey), ch), binding)
        return ClientSecureChannel.connect(deviceId, devicePub, identity, ch, wire, now, binding::bind)
    }

    private suspend fun recoverPairing(payload: PairingPayload): ChannelPair? {
        val channel = runCatching { connect(payload.deviceId, payload.deviceIdentityPubBytes) }.getOrNull() ?: return null
        return runCatching {
            val grant = DirectoryKeyGrant.parse(channel.requestJson("GET", "/e2ee/v1/directory-key"))
            val grants = channel.requestJson("GET", "/e2ee/v1/trust").optJSONArray("grants")
            val grantedAt = (0 until (grants?.length() ?: 0))
                .mapNotNull { grants?.optJSONObject(it) }
                .firstOrNull { it.optString("clientId") == channel.clientId }
                ?.optString("grantedAt").orEmpty()
            ChannelPair(channel, grantedAt, grant)
        }.onFailure { channel.close() }.getOrNull()
    }

    /** `ready` 里的列表密钥与本地不同时（设备轮换过），经通道取当前的。 */
    private suspend fun syncDirectoryKey(channel: ClientSecureChannel) {
        val ready = channel.ready ?: return
        val stored = trust.device(channel.deviceId) ?: return
        if (ready.directoryKeyId == stored.directoryKeyId && ready.directoryKeyEpoch == stored.directoryKeyEpoch) return
        runCatching { trust.updateDirectoryKey(DirectoryKeyGrant.parse(channel.requestJson("GET", "/e2ee/v1/directory-key"))) }
    }

    private fun isExpired(payload: PairingPayload): Boolean =
        runCatching { Instant.parse(payload.expiresAt).toEpochMilli() <= now() }.getOrDefault(false)

    private companion object {
        private val NOT_RECOVERABLE = setOf(
            E2eeErrorCodes.DEVICE_PIN_MISMATCH,
            E2eeErrorCodes.PAIRING_EXPIRED,
            E2eeErrorCodes.NOT_PAIRED,
            E2eeErrorCodes.HANDSHAKE_FAILED,
        )

    }
}
