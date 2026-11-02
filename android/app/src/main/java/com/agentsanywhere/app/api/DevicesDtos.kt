package com.agentsanywhere.app.api

import com.agentsanywhere.app.model.ModelConnectionCapability
import com.agentsanywhere.app.model.ModelConnectionStatus
import com.agentsanywhere.app.model.SecretFieldState

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
    /** Step inside a non-error status (e.g. syncing while starting). Informational only. */
    val phase: Map<String, Any?>? = null,
    val lastDiscoveredAt: String?,
    val updatedAt: String?,
    /** "experimental", "beta" or "stable"; null when the Server does not say. */
    val maturity: String? = null,
    val modelConnection: ModelConnectionCapability? = null,
    val modelConnectionStatus: ModelConnectionStatus? = null,
    /** Write-only values left out of [config], by path such as `modelGateway.apiKey`. */
    val secretFields: Map<String, SecretFieldState> = emptyMap(),
    /** "model-config" when the model configuration created this instance. */
    val managedBy: String? = null,
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
