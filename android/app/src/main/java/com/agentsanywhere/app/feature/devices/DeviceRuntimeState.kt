package com.agentsanywhere.app.feature.devices

import com.agentsanywhere.app.api.RemoteDeviceRuntime
import com.agentsanywhere.app.api.RemoteDeviceRuntimeList
import com.agentsanywhere.app.api.RemoteDeviceRuntimeStatus

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
    val present: Boolean,
    val configured: Boolean,
    val active: Boolean,
    val status: DeviceRuntimeStatus,
    val discovery: Map<String, Any?>,
    val metadata: Map<String, Any?> = emptyMap(),
    val schema: Map<String, Any?>?,
    val uiSchema: Map<String, Any?>,
    val config: Map<String, Any?>?,
    val error: Map<String, Any?>?,
    val lastDiscoveredAt: String?,
    val updatedAt: String?,
) {
    val detailMessage: String?
        get() = error.stringValue("message")
            ?: error.stringValue("code")
            ?: discovery.stringValue("reason")

    val canActivate: Boolean
        get() = present && configured

    val discoveryAvailable: Boolean
        get() = discovery["available"] != false
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

data class DeviceRuntimeManagementState(
    val connectorId: String? = null,
    val runtimes: List<DeviceRuntime> = emptyList(),
    val loading: Boolean = false,
    val discovering: Boolean = false,
    val pendingRuntimeId: String? = null,
    val errorMessage: String? = null,
    val errorFromDiscovery: Boolean = false,
) {
    val configuredRuntimes: List<DeviceRuntime>
        get() = runtimes.filter(DeviceRuntime::configured).sortedWith(deviceRuntimeComparator)

    val discoveredUnconfiguredRuntimes: List<DeviceRuntime>
        get() = runtimes
            .filter { it.present && !it.configured }
            .sortedWith(deviceRuntimeComparator)

    fun replace(result: DeviceRuntimeList): DeviceRuntimeManagementState {
        return copy(
            connectorId = result.connectorId,
            runtimes = result.runtimes.sortedWith(deviceRuntimeComparator),
            loading = false,
            discovering = false,
            pendingRuntimeId = null,
            errorMessage = null,
            errorFromDiscovery = false,
        )
    }

    fun replace(runtime: DeviceRuntime): DeviceRuntimeManagementState {
        val next = if (runtimes.any { it.id == runtime.id }) {
            runtimes.map { current -> if (current.id == runtime.id) runtime else current }
        } else {
            runtimes + runtime
        }
        return copy(
            connectorId = runtime.connectorId,
            runtimes = next.sortedWith(deviceRuntimeComparator),
            errorMessage = null,
            errorFromDiscovery = false,
        )
    }

    fun discoveryFailed(message: String): DeviceRuntimeManagementState {
        return copy(
            discovering = false,
            errorMessage = message,
            errorFromDiscovery = true,
        )
    }
}

sealed interface DeviceRuntimeSetupResult {
    data class Success(val runtime: DeviceRuntime) : DeviceRuntimeSetupResult
    data class SaveFailed(val cause: Throwable) : DeviceRuntimeSetupResult
    data class StartFailed(
        val configuredRuntime: DeviceRuntime,
        val cause: Throwable,
    ) : DeviceRuntimeSetupResult
}

internal suspend fun configureAndStartRuntime(
    saveConfig: suspend () -> Result<DeviceRuntime>,
    startRuntime: suspend () -> Result<DeviceRuntime>,
): DeviceRuntimeSetupResult {
    val configured = saveConfig().getOrElse { return DeviceRuntimeSetupResult.SaveFailed(it) }
    return startRuntime().fold(
        onSuccess = { DeviceRuntimeSetupResult.Success(it) },
        onFailure = { DeviceRuntimeSetupResult.StartFailed(configured, it) },
    )
}

data class RuntimeEnvironmentVariable(
    val key: String,
    val value: String,
    val removeInheritedValue: Boolean = false,
)

data class DeviceRuntimeConfigDraft(
    val baseConfig: Map<String, Any?>,
    val fieldOrder: List<String>,
    val supportsExecutablePath: Boolean,
    val supportsEnvironment: Boolean,
    val executablePath: String,
    val environment: List<RuntimeEnvironmentVariable>,
) {
    fun validationError(): RuntimeConfigValidationError? {
        if (!supportsEnvironment) return null
        if (environment.any { it.key.isBlank() }) return RuntimeConfigValidationError.BlankName
        if (environment.any { '=' in it.key || '\u0000' in it.key }) {
            return RuntimeConfigValidationError.InvalidName
        }
        if (environment.map { it.key }.distinct().size != environment.size) {
            return RuntimeConfigValidationError.DuplicateName
        }
        return null
    }

    fun toConfig(): Map<String, Any?> {
        val next = baseConfig.toMutableMap()
        if (supportsExecutablePath) {
            executablePath.trim().takeIf(String::isNotEmpty)?.let {
                next["executablePath"] = it
            } ?: next.remove("executablePath")
        }
        if (supportsEnvironment) {
            next["environment"] = environment.associate { variable ->
                variable.key to if (variable.removeInheritedValue) null else variable.value
            }
        }
        return next
    }
}

enum class RuntimeConfigValidationError {
    BlankName,
    InvalidName,
    DuplicateName,
}

fun DeviceRuntime.toConfigDraft(): DeviceRuntimeConfigDraft {
    val properties = schema?.get("properties") as? Map<*, *>
    val supportedFields = properties
        ?.keys
        ?.mapNotNull { it as? String }
        .orEmpty()
    val requestedOrder = (uiSchema["order"] as? List<*>)
        ?.mapNotNull { it as? String }
        .orEmpty()
    val fieldOrder = (requestedOrder + supportedFields).distinct()
    val environment = (config?.get("environment") as? Map<*, *>)
        ?.mapNotNull { (key, value) ->
            val name = key as? String ?: return@mapNotNull null
            when (value) {
                null -> RuntimeEnvironmentVariable(name, "", removeInheritedValue = true)
                is String -> RuntimeEnvironmentVariable(name, value)
                else -> null
            }
        }
        ?.sortedBy { it.key.lowercase() }
        .orEmpty()
    return DeviceRuntimeConfigDraft(
        baseConfig = config.orEmpty(),
        fieldOrder = fieldOrder,
        supportsExecutablePath = "executablePath" in supportedFields,
        supportsEnvironment = "environment" in supportedFields,
        executablePath = config?.get("executablePath") as? String
            ?: schema.stringDefault("executablePath").orEmpty(),
        environment = environment,
    )
}

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
        present = present,
        configured = configured,
        active = active,
        status = status.toDeviceRuntimeStatus(),
        discovery = discovery,
        metadata = metadata,
        schema = schema,
        uiSchema = uiSchema,
        config = config,
        error = error,
        lastDiscoveredAt = lastDiscoveredAt,
        updatedAt = updatedAt,
    )
}

private val deviceRuntimeComparator = compareBy<DeviceRuntime> {
    when (it.id) {
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

private fun Map<String, Any?>?.stringDefault(field: String): String? {
    val properties = this?.get("properties") as? Map<*, *> ?: return null
    val schema = properties[field] as? Map<*, *> ?: return null
    return schema["default"] as? String
}
