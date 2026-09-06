package com.agentsanywhere.app.ui.screens.home

import com.agentsanywhere.app.feature.devices.DeviceRuntimeStatus
import com.agentsanywhere.app.feature.sessions.SessionsState
import com.agentsanywhere.app.feature.sessions.activeNewSessionRuntimes
import com.agentsanywhere.app.model.AgentDevice

internal enum class NewSessionSetupReason {
    CheckingDevices, DeviceLoadFailed, NoDevices, DevicesOffline,
    CheckingAgents, AgentLoadFailed, NeedsAgentSetup, NeedsAgentStart, AgentStarting,
}

internal data class NewSessionSetupState(
    val reason: NewSessionSetupReason,
    val device: AgentDevice? = null,
)

/** Resolve prerequisites before rendering controls that require a running Agent. */
internal fun newSessionSetupState(
    sessions: SessionsState,
    inventory: NewSessionRuntimeInventory,
    projectConnectorId: String?,
    selectedConnectorId: String?,
    hasSelectedRuntime: Boolean,
): NewSessionSetupState? {
    if (!sessions.hasLoaded) {
        return NewSessionSetupState(
            if (sessions.errorMessage != null && !sessions.isLoading) NewSessionSetupReason.DeviceLoadFailed
            else NewSessionSetupReason.CheckingDevices,
        )
    }
    if (sessions.devices.isEmpty()) {
        return NewSessionSetupState(
            if (sessions.errorMessage != null) NewSessionSetupReason.DeviceLoadFailed else NewSessionSetupReason.NoDevices,
        )
    }
    // A session opened from a project must stay on that project's device.
    val projectDevice = sessions.devices.firstOrNull { it.id == projectConnectorId }
    if (projectConnectorId != null && projectDevice == null) return NewSessionSetupState(NewSessionSetupReason.NoDevices)
    val candidates = if (projectDevice != null) listOf(projectDevice) else sessions.devices
    val online = candidates.filter(AgentDevice::online)
    val device = projectDevice ?: online.firstOrNull { it.id == selectedConnectorId }
        ?: online.singleOrNull() ?: candidates.singleOrNull()
    if (online.isEmpty()) return NewSessionSetupState(NewSessionSetupReason.DevicesOffline, device)
    if (hasSelectedRuntime && online.any { it.id == selectedConnectorId }) return null

    val ids = online.map(AgentDevice::id)
    val hasReadyAgent = ids.any { it !in inventory.errors && activeNewSessionRuntimes(inventory.results[it]?.runtimes.orEmpty()).isNotEmpty() }
    val pending = ids.any { it in inventory.pendingInitial || (it !in inventory.results && it !in inventory.errors) }
    if (hasReadyAgent || pending || !inventory.hasLoaded) {
        return NewSessionSetupState(NewSessionSetupReason.CheckingAgents, device)
    }
    if (ids.any { it in inventory.errors }) return NewSessionSetupState(NewSessionSetupReason.AgentLoadFailed, device)

    val runtimes = ids.flatMap { inventory.results[it]?.runtimes.orEmpty() }
    val starting = runtimes.any {
        it.configured && it.active && it.status in setOf(
            DeviceRuntimeStatus.Starting, DeviceRuntimeStatus.Validating, DeviceRuntimeStatus.Discovering,
        )
    }
    val reason = when {
        starting -> NewSessionSetupReason.AgentStarting
        runtimes.none { it.configured && it.present } -> NewSessionSetupReason.NeedsAgentSetup
        else -> NewSessionSetupReason.NeedsAgentStart
    }
    return NewSessionSetupState(reason, device)
}
