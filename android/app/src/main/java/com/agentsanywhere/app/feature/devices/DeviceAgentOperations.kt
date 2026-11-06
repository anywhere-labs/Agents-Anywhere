package com.agentsanywhere.app.feature.devices

import kotlinx.coroutines.CancellationException

/** Server operations behind Agent management; each call reads or writes the current account's data. */
interface DeviceAgentOperations {
    suspend fun listDeviceRuntimes(connectorId: String): Result<DeviceRuntimeList>
    suspend fun listDeviceRuntimeTypes(connectorId: String, discover: Boolean = false): Result<List<DeviceRuntimeType>>
    suspend fun createDeviceRuntime(
        connectorId: String,
        runtimeType: String,
        name: String,
        config: Map<String, Any?>,
        active: Boolean,
    ): Result<DeviceRuntime>
    suspend fun renameDeviceRuntime(connectorId: String, runtimeId: String, name: String): Result<DeviceRuntime>
    suspend fun saveDeviceRuntimeConfig(connectorId: String, runtimeId: String, config: Map<String, Any?>): Result<DeviceRuntime>
    suspend fun setDeviceRuntimeActive(connectorId: String, runtimeId: String, active: Boolean): Result<DeviceRuntime>
    suspend fun deleteDeviceRuntimeConfig(connectorId: String, runtimeId: String): Result<DeviceRuntime>
}

/** Calls [onChanged] after each successful write, e.g. to refresh Agent counts elsewhere. */
fun DeviceAgentOperations.observingChanges(onChanged: () -> Unit): DeviceAgentOperations {
    val delegate = this
    return object : DeviceAgentOperations by delegate {
        override suspend fun createDeviceRuntime(
            connectorId: String,
            runtimeType: String,
            name: String,
            config: Map<String, Any?>,
            active: Boolean,
        ) = delegate.createDeviceRuntime(connectorId, runtimeType, name, config, active).onSuccess { onChanged() }

        override suspend fun renameDeviceRuntime(connectorId: String, runtimeId: String, name: String) =
            delegate.renameDeviceRuntime(connectorId, runtimeId, name).onSuccess { onChanged() }

        override suspend fun saveDeviceRuntimeConfig(connectorId: String, runtimeId: String, config: Map<String, Any?>) =
            delegate.saveDeviceRuntimeConfig(connectorId, runtimeId, config).onSuccess { onChanged() }

        override suspend fun setDeviceRuntimeActive(connectorId: String, runtimeId: String, active: Boolean) =
            delegate.setDeviceRuntimeActive(connectorId, runtimeId, active).onSuccess { onChanged() }

        override suspend fun deleteDeviceRuntimeConfig(connectorId: String, runtimeId: String) =
            delegate.deleteDeviceRuntimeConfig(connectorId, runtimeId).onSuccess { onChanged() }
    }
}

data class DeviceRuntimeAddRequest(
    /** Null keeps an existing instance's name, or suggests one for a new instance. */
    val name: String? = null,
    /** Null is a quick add: the Connector's defaults for a new instance, the saved values otherwise. */
    val config: Map<String, Any?>? = null,
    /** The instance an earlier attempt created or chose, so a retry continues with it. */
    val runtimeId: String? = null,
)

/** The instance a retry should continue with is gone, e.g. deleted from another client. */
class DeviceRuntimeMissingException : IllegalStateException("This Agent instance no longer exists.")

/** The device stopped reporting this type, e.g. after the Agent was uninstalled. */
class DeviceRuntimeTypeUnavailableException : IllegalStateException("This Agent is no longer available.")

/**
 * Adds and starts an Agent. The current inventory is read first, so a retry after a create
 * that persisted but failed to start reuses that instance instead of adding a second one,
 * and a write that already succeeded is not replayed.
 */
internal suspend fun addDeviceRuntime(
    operations: DeviceAgentOperations,
    connectorId: String,
    type: DeviceRuntimeType,
    request: DeviceRuntimeAddRequest = DeviceRuntimeAddRequest(),
    onRuntimeUpdated: (DeviceRuntime) -> Unit = {},
): DeviceRuntime {
    if (!type.present) throw DeviceRuntimeTypeUnavailableException()
    val runtimes = operations.listDeviceRuntimes(connectorId).getOrThrow().runtimes
    val name = request.name?.let(::normalizedRuntimeName)?.takeIf(String::isNotEmpty)
    var existing = if (request.runtimeId != null) {
        runtimes.firstOrNull { it.id == request.runtimeId && it.type == type.type }
            ?: throw DeviceRuntimeMissingException()
    } else {
        runtimes.firstOrNull { it.type == type.type && it.configured && (name == null || runtimeNameKey(it.name) == runtimeNameKey(name)) }
            ?: runtimes.firstOrNull { it.type == type.type && !it.configured }
    }
    if (existing == null) {
        val requestedName = name ?: suggestedRuntimeName(type, runtimes)
        return try {
            operations.createDeviceRuntime(connectorId, type.type, requestedName, request.config ?: emptyMap(), active = true)
                .getOrThrow()
                .also(onRuntimeUpdated)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            // Creation can persist before startup fails. Report the instance so a retry continues with it.
            operations.listDeviceRuntimes(connectorId).getOrNull()?.runtimes
                ?.firstOrNull { it.type == type.type && runtimeNameKey(it.name) == runtimeNameKey(requestedName) }
                ?.let(onRuntimeUpdated)
            throw error
        }
    }
    if (name != null && name != existing.name) {
        existing = operations.renameDeviceRuntime(connectorId, existing.id, name).getOrThrow().also(onRuntimeUpdated)
    }
    val starting = existing.status == DeviceRuntimeStatus.Running || existing.status == DeviceRuntimeStatus.Starting
    if (request.config == null && existing.configured && existing.active && starting) {
        onRuntimeUpdated(existing)
        return existing
    }
    if (!existing.configured || request.config != null) {
        operations.saveDeviceRuntimeConfig(connectorId, existing.id, request.config ?: emptyMap())
            .getOrThrow()
            .also(onRuntimeUpdated)
    }
    return operations.setDeviceRuntimeActive(connectorId, existing.id, true).getOrThrow().also(onRuntimeUpdated)
}
