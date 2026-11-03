package com.agentsanywhere.app.feature.devices

import com.agentsanywhere.app.api.RemoteDeviceRuntime
import com.agentsanywhere.app.api.RemoteDeviceRuntimeList
import com.agentsanywhere.app.api.RemoteDeviceRuntimeStatus
import com.agentsanywhere.app.model.ModelConnectionCapability
import com.agentsanywhere.app.model.ModelConnectionStatus
import com.agentsanywhere.app.model.RuntimeInstanceLabels
import com.agentsanywhere.app.model.SecretFieldState
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
    val maturity: String? = null,
    val modelConnection: ModelConnectionCapability? = null,
    val modelConnectionStatus: ModelConnectionStatus? = null,
    val secretFields: Map<String, SecretFieldState> = emptyMap(),
    val managedBy: String? = null,
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
        val next = withoutBlankSecrets(baseConfig).toMutableMap()
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

/**
 * Write-only values such as `modelGateway.apiKey` never come back from the Server.
 * A save leaves them out so the Server keeps the stored value; a blank one would
 * read as clearing it.
 */
internal fun withoutBlankSecrets(config: Map<String, Any?>): Map<String, Any?> {
    return config.mapValues { (_, value) ->
        val nested = value as? Map<*, *> ?: return@mapValues value
        val secret = nested[WRITE_ONLY_KEY]
        if (WRITE_ONLY_KEY in nested && (secret == null || (secret as? String)?.isBlank() == true)) {
            nested.filterKeys { it != WRITE_ONLY_KEY }
        } else {
            value
        }
    }
}

private const val WRITE_ONLY_KEY = "apiKey"

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
            ?: ((properties?.get("executablePath") as? Map<*, *>)?.get("default") as? String).orEmpty(),
        environment = environment,
    )
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
        maturity = maturity,
        modelConnection = modelConnection,
        modelConnectionStatus = modelConnectionStatus,
        secretFields = secretFields,
        managedBy = managedBy,
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
