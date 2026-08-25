package com.agentsanywhere.app.api

data class RemoteDevice(
    val id: String,
    val name: String,
    val deviceOs: String?,
    val status: String,
    val lastSeenAt: String?,
    val createdAt: String?,
    val updatedAt: String?,
)

data class RemoteDeviceCredential(
    val device: RemoteDevice,
    val deviceToken: String,
    val tokenPrefix: String?,
)

data class RemoteDeviceRuntimeList(
    val connectorId: String,
    val runtimes: List<RemoteDeviceRuntime>,
    val serverTime: String?,
)

data class RemoteDeviceRuntime(
    val connectorId: String,
    val runtimeId: String,
    val runtimeType: String,
    val displayName: String,
    val present: Boolean,
    val configured: Boolean,
    val active: Boolean,
    val status: RemoteDeviceRuntimeStatus,
    val discovery: Map<String, Any?>,
    val metadata: Map<String, Any?> = emptyMap(),
    val schema: Map<String, Any?>?,
    val uiSchema: Map<String, Any?>,
    val config: Map<String, Any?>?,
    val error: Map<String, Any?>?,
    val lastDiscoveredAt: String?,
    val updatedAt: String?,
) {
    val name: String
        get() = displayName
}

enum class RemoteDeviceRuntimeStatus(val wireValue: String) {
    Stopped("stopped"),
    Discovering("discovering"),
    Available("available"),
    Unavailable("unavailable"),
    Validating("validating"),
    Starting("starting"),
    Running("running"),
    Stopping("stopping"),
    Error("error"),
    Unknown("unknown"),
    ;

    companion object {
        fun fromWireValue(value: String): RemoteDeviceRuntimeStatus {
            return entries.firstOrNull { it.wireValue == value } ?: Unknown
        }
    }
}
