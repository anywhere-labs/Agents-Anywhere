package com.agentsanywhere.app.feature.devices

import com.agentsanywhere.app.model.AgentDevice

data class DevicesState(
    val devices: List<AgentDevice> = emptyList(),
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
)
