package com.agentsanywhere.app.feature.devices

import com.agentsanywhere.app.api.RemoteDeviceSettings
import com.agentsanywhere.app.model.AgentDevice

/** Behaviour switches the user chose for one device; the Server sends them to its Connector. */
data class DeviceSettings(
    val confirmQuitOnShutdown: Boolean = false,
)

data class DeviceSettingsResult(
    val settings: DeviceSettings,
    /** False when the device was offline or too old: the Server saved it and applies it on reconnect. Null for reads. */
    val delivered: Boolean?,
)

interface DeviceSettingsOperations {
    suspend fun getDeviceSettings(connectorId: String): Result<DeviceSettingsResult>
    suspend fun updateDeviceSettings(connectorId: String, confirmQuitOnShutdown: Boolean): Result<DeviceSettingsResult>
}

/** Only Desktop devices act on device settings today. */
val AgentDevice.hasDeviceSettings: Boolean
    get() = connectorKind == "desktop"

fun RemoteDeviceSettings.toDeviceSettingsResult(): DeviceSettingsResult {
    return DeviceSettingsResult(
        settings = DeviceSettings(confirmQuitOnShutdown = confirmQuitOnShutdown),
        delivered = delivered,
    )
}

/** What the device settings section shows; [settings] is null until the first read succeeds. */
data class DeviceSettingsState(
    val settings: DeviceSettings? = null,
    val loading: Boolean = false,
    val saving: Boolean = false,
    val loadFailed: Boolean = false,
) {
    val canEdit: Boolean
        get() = settings != null && !loading && !saving

    fun loadStarted(): DeviceSettingsState = copy(loading = true, loadFailed = false)

    fun loaded(result: DeviceSettingsResult): DeviceSettingsState =
        copy(settings = result.settings, loading = false, loadFailed = false)

    fun loadFailed(): DeviceSettingsState = copy(loading = false, loadFailed = settings == null)

    /** Shows the new value right away; [saveFailed] puts [previous] back. */
    fun saveStarted(confirmQuitOnShutdown: Boolean): DeviceSettingsState =
        copy(settings = (settings ?: DeviceSettings()).copy(confirmQuitOnShutdown = confirmQuitOnShutdown), saving = true)

    fun saved(result: DeviceSettingsResult): DeviceSettingsState = copy(settings = result.settings, saving = false)

    fun saveFailed(previous: DeviceSettings?): DeviceSettingsState = copy(settings = previous, saving = false)
}
