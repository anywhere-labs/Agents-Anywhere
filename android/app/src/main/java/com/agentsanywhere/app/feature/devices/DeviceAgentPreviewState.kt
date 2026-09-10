package com.agentsanywhere.app.feature.devices

sealed interface DeviceAgentPreviewState {
    data object Loading : DeviceAgentPreviewState

    data class Loaded(
        val onlineAgentCount: Int,
    ) : DeviceAgentPreviewState

    data object Unavailable : DeviceAgentPreviewState
}

data class DeviceAgentPreviews(
    val generation: Long = 0L,
    val byDeviceId: Map<String, DeviceAgentPreviewState> = emptyMap(),
) {
    fun beginRefresh(onlineDeviceIds: Set<String>): DeviceAgentPreviews {
        return copy(
            generation = generation + 1L,
            byDeviceId = onlineDeviceIds.associateWith { deviceId ->
                when (val current = byDeviceId[deviceId]) {
                    is DeviceAgentPreviewState.Loaded -> current
                    else -> DeviceAgentPreviewState.Loading
                }
            },
        )
    }

    fun loaded(
        requestGeneration: Long,
        deviceId: String,
        onlineAgentCount: Int,
    ): DeviceAgentPreviews {
        if (requestGeneration != generation || deviceId !in byDeviceId) return this
        return copy(
            byDeviceId = byDeviceId +
                (deviceId to DeviceAgentPreviewState.Loaded(onlineAgentCount)),
        )
    }

    fun failed(
        requestGeneration: Long,
        deviceId: String,
    ): DeviceAgentPreviews {
        if (requestGeneration != generation ||
            deviceId !in byDeviceId ||
            byDeviceId[deviceId] is DeviceAgentPreviewState.Loaded
        ) {
            return this
        }
        return copy(
            byDeviceId = byDeviceId + (deviceId to DeviceAgentPreviewState.Unavailable),
        )
    }
}

internal fun DeviceRuntimeList.onlineAgentCount(): Int {
    return runtimes.count { runtime ->
        runtime.configured &&
            runtime.active &&
            runtime.status == DeviceRuntimeStatus.Running
    }
}
