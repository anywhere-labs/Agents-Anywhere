package com.agentsanywhere.app.feature.devices

import com.agentsanywhere.app.model.AgentDevice

/** Count persisted configuration, including offline devices and stopped Agents. */
suspend fun hasConfiguredDeviceAgents(
    devices: List<AgentDevice>,
    listRuntimes: suspend (String) -> Result<DeviceRuntimeList>,
): Boolean = devices.any { device ->
    listRuntimes(device.id).getOrThrow().runtimes.any { it.configured }
}
