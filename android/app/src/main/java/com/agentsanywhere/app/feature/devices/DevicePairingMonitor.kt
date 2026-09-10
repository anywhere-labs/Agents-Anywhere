package com.agentsanywhere.app.feature.devices

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.model.AgentDevice
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

enum class DevicePairingStatus { Waiting, Online }

/** Owned by the authenticated app, so leaving the setup page does not cancel pairing. */
class DevicePairingMonitor {
    private val entries = MutableStateFlow<Map<String, DevicePairingStatus>>(emptyMap())
    val states = entries.asStateFlow()

    fun waitForDevice(id: String) {
        entries.update { it + (id to DevicePairingStatus.Waiting) }
    }

    fun clear(id: String) {
        entries.update { it - id }
    }

    suspend fun observe(
        loadDevice: suspend (String) -> Result<AgentDevice>,
        onOnline: (AgentDevice) -> Unit,
    ) {
        entries.map { state -> state.filterValues { it == DevicePairingStatus.Waiting }.keys }
            .distinctUntilChanged()
            .collectLatest { pendingIds ->
                coroutineScope {
                    pendingIds.forEach { id ->
                        launch {
                            delay(1_500)
                            while (isActive) {
                                val result = loadDevice(id)
                                val device = result.getOrNull()
                                if (device?.online == true) {
                                    onOnline(device)
                                    entries.update { if (id in it) it + (id to DevicePairingStatus.Online) else it }
                                    return@launch
                                }
                                val status = (result.exceptionOrNull() as? ApiException)?.statusCode
                                if (status != null && status != 0 && status !in setOf(408, 409, 425, 429) && status < 500) {
                                    clear(id)
                                    return@launch
                                }
                                delay(if (result.isFailure) 3_000 else 2_000)
                            }
                        }
                    }
                }
            }
    }
}
