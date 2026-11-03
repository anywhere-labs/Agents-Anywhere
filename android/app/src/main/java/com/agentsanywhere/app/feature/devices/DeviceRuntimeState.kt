package com.agentsanywhere.app.feature.devices

import com.agentsanywhere.app.api.RemoteDeviceRuntime
import com.agentsanywhere.app.api.RemoteDeviceRuntimeList
import com.agentsanywhere.app.api.RemoteDeviceRuntimeStatus
import com.agentsanywhere.app.model.RuntimeInstanceLabels
import com.agentsanywhere.app.model.runtimeInstanceLabels

data class DeviceRuntimeList(
    val connectorId: String,
    val runtimes: List<DeviceRuntime>,
    val serverTime: String?,
)

data class DeviceRuntime(
    val connectorId: String,
    val id: String,
    val type: String,
    val displayName: String,
    val typeDisplayName: String? = null,
    val present: Boolean,
    val configured: Boolean,
    val active: Boolean,
    val status: DeviceRuntimeStatus,
    val discovery: Map<String, Any?>,
    val metadata: Map<String, Any?> = emptyMap(),
    val schema: Map<String, Any?>?,
    val uiSchema: Map<String, Any?>,
    val defaults: Map<String, Any?> = emptyMap(),
    val config: Map<String, Any?>?,
    val error: Map<String, Any?>?,
    /** Step inside a non-error status, e.g. syncing sessions while starting. */
    val phase: Map<String, Any?>? = null,
    val lastDiscoveredAt: String?,
    val updatedAt: String?,
) {
    val name: String
        get() = displayName

    val labels: RuntimeInstanceLabels
        get() = runtimeInstanceLabels(name, type)

    val detailMessage: String?
        get() = error.stringValue("message")
            ?: error.stringValue("code")
            ?: discovery.stringValue("reason")

    val errorCode: String?
        get() = error.stringValue("code")

    val errorMessage: String?
        get() = error.stringValue("message")

    val phaseMessage: String?
        get() = phase.stringValue("message")

    val canActivate: Boolean
        get() = present && configured

    val discoveryAvailable: Boolean
        get() = discovery["available"] != false

    /** The default instance of a single-instance type uses the type as its ID. */
    val isDefaultInstance: Boolean
        get() = id == type
}

enum class DeviceRuntimeStatus {
    Stopped,
    Discovering,
    Available,
    Unavailable,
    Validating,
    Starting,
    Running,
    Stopping,
    Error,
    Unknown,
}

/**
 * Deletion removes the instance; the response is its final state under the
 * same ID. A server that still returns an unconfigured successor under a new
 * ID keeps that successor in the list.
 */
internal fun List<DeviceRuntime>.afterRuntimeDeletion(deletedId: String, response: DeviceRuntime): List<DeviceRuntime> {
    val remaining = filterNot { it.id == deletedId || it.id == response.id }
    return if (response.id == deletedId) remaining else remaining + response
}

internal fun List<DeviceRuntime>.withRuntime(runtime: DeviceRuntime): List<DeviceRuntime> =
    if (any { it.id == runtime.id }) map { if (it.id == runtime.id) runtime else it } else this + runtime

internal fun RemoteDeviceRuntimeList.toDeviceRuntimeList(): DeviceRuntimeList {
    return DeviceRuntimeList(
        connectorId = connectorId,
        runtimes = runtimes.map(RemoteDeviceRuntime::toDeviceRuntime),
        serverTime = serverTime,
    )
}

internal fun RemoteDeviceRuntime.toDeviceRuntime(): DeviceRuntime {
    return DeviceRuntime(
        connectorId = connectorId,
        id = runtimeId,
        type = runtimeType,
        displayName = displayName,
        typeDisplayName = typeDisplayName,
        present = present,
        configured = configured,
        active = active,
        status = status.toDeviceRuntimeStatus(),
        discovery = discovery,
        metadata = metadata,
        schema = schema,
        uiSchema = uiSchema,
        defaults = defaults,
        config = config,
        error = error,
        phase = phase,
        lastDiscoveredAt = lastDiscoveredAt,
        updatedAt = updatedAt,
    )
}

internal val deviceRuntimeComparator = compareBy<DeviceRuntime> {
    when (it.type) {
        "codex" -> 0
        "claude" -> 1
        "dsh" -> 2
        else -> 99
    }
}.thenBy { it.displayName.lowercase() }

private fun RemoteDeviceRuntimeStatus.toDeviceRuntimeStatus(): DeviceRuntimeStatus {
    return when (this) {
        RemoteDeviceRuntimeStatus.Stopped -> DeviceRuntimeStatus.Stopped
        RemoteDeviceRuntimeStatus.Discovering -> DeviceRuntimeStatus.Discovering
        RemoteDeviceRuntimeStatus.Available -> DeviceRuntimeStatus.Available
        RemoteDeviceRuntimeStatus.Unavailable -> DeviceRuntimeStatus.Unavailable
        RemoteDeviceRuntimeStatus.Validating -> DeviceRuntimeStatus.Validating
        RemoteDeviceRuntimeStatus.Starting -> DeviceRuntimeStatus.Starting
        RemoteDeviceRuntimeStatus.Running -> DeviceRuntimeStatus.Running
        RemoteDeviceRuntimeStatus.Stopping -> DeviceRuntimeStatus.Stopping
        RemoteDeviceRuntimeStatus.Error -> DeviceRuntimeStatus.Error
        RemoteDeviceRuntimeStatus.Unknown -> DeviceRuntimeStatus.Unknown
    }
}

private fun Map<String, Any?>?.stringValue(key: String): String? {
    return (this?.get(key) as? String)?.takeIf { it.isNotBlank() }
}
