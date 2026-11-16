package com.agentsanywhere.app.feature.e2ee

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.e2ee.ChannelClosedException
import com.agentsanywhere.app.api.e2ee.E2eeErrorCodes
import com.agentsanywhere.app.api.e2ee.InvalidPairingUriException
import com.agentsanywhere.app.api.e2ee.PairingPayload
import com.agentsanywhere.app.api.e2ee.parsePairingUri
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

/** 设备详情里显示的加密状态。 */
data class DeviceE2eeStatus(
    val paired: PairedDevice?,
    val transport: DeviceTransport,
    val clientFingerprint: String,
)

/** 读本机记录（会碰 Keystore 与磁盘，放后台线程）。 */
suspend fun E2eeClient.status(deviceId: String): DeviceE2eeStatus = withContext(Dispatchers.IO) {
    DeviceE2eeStatus(pairedDevice(deviceId), transportFor(deviceId), clientFingerprint)
}

/** 配对流程：扫码或粘贴 → 显示设备指纹 → 配对 → 完成或失败。 */
data class E2eePairingState(
    val stage: Stage = Stage.Scan,
    val payload: PairingPayload? = null,
    val pastedLink: String = "",
    val paired: PairedDevice? = null,
    val error: E2eePairingError? = null,
) {
    enum class Stage { Scan, Confirm, Pairing, Paired }

    val deviceFingerprint: String? get() = paired?.deviceFingerprint ?: payload?.deviceFingerprint

    /** 扫到或粘贴了一个链接；只有属于 [expectedDeviceId] 的二维码才能进入确认。 */
    fun linkEntered(text: String, expectedDeviceId: String?): E2eePairingState {
        if (stage != Stage.Scan) return this
        val payload = try {
            parsePairingUri(text)
        } catch (_: InvalidPairingUriException) {
            return copy(error = E2eePairingError.InvalidLink)
        }
        if (expectedDeviceId != null && payload.deviceId != expectedDeviceId) return copy(error = E2eePairingError.WrongDevice)
        return copy(stage = Stage.Confirm, payload = payload, error = null)
    }

    fun pastedLinkChanged(text: String): E2eePairingState = copy(pastedLink = text, error = null)

    fun started(): E2eePairingState = copy(stage = Stage.Pairing, error = null)

    fun succeeded(device: PairedDevice): E2eePairingState = copy(stage = Stage.Paired, paired = device, error = null)

    /** 失败后回到扫码：二维码只能用一次，重试要重新扫。 */
    fun failed(error: E2eePairingError): E2eePairingState = E2eePairingState(error = error)

    fun restart(): E2eePairingState = E2eePairingState()
}

/** 给界面的错误种类；文案在 ui 层。 */
enum class E2eePairingError {
    InvalidLink,
    WrongDevice,
    Expired,
    DevicePinMismatch,
    NotPaired,
    HandshakeFailed,
    Unavailable,
    Timeout,
    Failed,
    ;

    companion object {
        fun from(error: Throwable): E2eePairingError = when (error) {
            is TimeoutCancellationException -> Timeout
            is ChannelClosedException -> when (error.code) {
                E2eeErrorCodes.PAIRING_EXPIRED -> Expired
                E2eeErrorCodes.DEVICE_PIN_MISMATCH -> DevicePinMismatch
                E2eeErrorCodes.NOT_PAIRED -> NotPaired
                E2eeErrorCodes.HANDSHAKE_FAILED -> HandshakeFailed
                E2eeErrorCodes.CONNECTOR_OFFLINE, E2eeErrorCodes.TUNNEL_DISCONNECTED -> Unavailable
                else -> Failed
            }
            is ApiException -> Unavailable
            else -> Failed
        }
    }
}

/** 跑一次配对；结果写进状态。Noise 与 Keystore 操作放在后台线程。 */
suspend fun E2eeClient.pairForState(
    state: E2eePairingState,
    label: String,
    appVersion: String?,
    timeoutMillis: Long = 30_000,
): E2eePairingState {
    val payload = state.payload ?: return state.failed(E2eePairingError.InvalidLink)
    return try {
        val device = withContext(Dispatchers.Default) { withTimeout(timeoutMillis) { pair(payload, label, appVersion) } }
        state.succeeded(device)
    } catch (error: TimeoutCancellationException) {
        state.failed(E2eePairingError.Timeout)
    } catch (error: CancellationException) {
        throw error
    } catch (error: Exception) {
        state.failed(E2eePairingError.from(error))
    }
}
