package com.agentsanywhere.app.feature.devices

/** In-memory Server for Agent operations; records every write in [calls]. */
internal class FakeDeviceAgentOperations(
    var runtimes: List<DeviceRuntime> = emptyList(),
    var types: List<DeviceRuntimeType> = emptyList(),
) : DeviceAgentOperations {
    val calls = mutableListOf<String>()
    var failCreateAfterPersisting = false
    var failStart: Throwable? = null
    var failList: Throwable? = null
    var discovered = 0
    private var nextId = 1

    override suspend fun listDeviceRuntimes(connectorId: String): Result<DeviceRuntimeList> {
        failList?.let { return Result.failure(it) }
        return Result.success(DeviceRuntimeList(connectorId, runtimes, serverTime = null))
    }

    override suspend fun listDeviceRuntimeTypes(connectorId: String, discover: Boolean): Result<List<DeviceRuntimeType>> {
        failList?.let { return Result.failure(it) }
        if (discover) discovered++
        return Result.success(types)
    }

    override suspend fun createDeviceRuntime(
        connectorId: String,
        runtimeType: String,
        name: String,
        config: Map<String, Any?>,
        active: Boolean,
    ): Result<DeviceRuntime> {
        calls += "create:$runtimeType:$name:$active"
        val created = runtime(id = "rti_${nextId++}", type = runtimeType, name = name, configured = true, active = active)
            .copy(config = config, status = DeviceRuntimeStatus.Running)
        if (failCreateAfterPersisting) {
            runtimes = runtimes + created.copy(status = DeviceRuntimeStatus.Error)
            return Result.failure(IllegalStateException("start failed"))
        }
        runtimes = runtimes + created
        return Result.success(created)
    }

    override suspend fun renameDeviceRuntime(connectorId: String, runtimeId: String, name: String): Result<DeviceRuntime> {
        calls += "rename:$runtimeId:$name"
        return update(runtimeId) { it.copy(displayName = name) }
    }

    override suspend fun saveDeviceRuntimeConfig(connectorId: String, runtimeId: String, config: Map<String, Any?>): Result<DeviceRuntime> {
        calls += "config:$runtimeId"
        return update(runtimeId) { it.copy(configured = true, config = config) }
    }

    override suspend fun setDeviceRuntimeActive(connectorId: String, runtimeId: String, active: Boolean): Result<DeviceRuntime> {
        calls += "active:$runtimeId:$active"
        failStart?.let { return Result.failure(it) }
        return update(runtimeId) {
            it.copy(active = active, status = if (active) DeviceRuntimeStatus.Running else DeviceRuntimeStatus.Stopped)
        }
    }

    override suspend fun deleteDeviceRuntimeConfig(connectorId: String, runtimeId: String): Result<DeviceRuntime> {
        calls += "delete:$runtimeId"
        val deleted = runtimes.first { it.id == runtimeId }.copy(configured = false, active = false, config = null)
        runtimes = runtimes.filterNot { it.id == runtimeId }
        return Result.success(deleted)
    }

    private fun update(runtimeId: String, change: (DeviceRuntime) -> DeviceRuntime): Result<DeviceRuntime> {
        val current = runtimes.firstOrNull { it.id == runtimeId } ?: return Result.failure(IllegalStateException("missing"))
        val next = change(current)
        runtimes = runtimes.map { if (it.id == runtimeId) next else it }
        return Result.success(next)
    }
}

internal fun runtime(
    id: String,
    type: String = "claude",
    name: String = id,
    configured: Boolean = true,
    active: Boolean = false,
    status: DeviceRuntimeStatus = DeviceRuntimeStatus.Stopped,
) = DeviceRuntime(
    connectorId = "device",
    id = id,
    type = type,
    displayName = name,
    present = true,
    configured = configured,
    active = active,
    status = status,
    discovery = emptyMap(),
    schema = mapOf("type" to "object", "properties" to emptyMap<String, Any?>()),
    uiSchema = emptyMap(),
    config = if (configured) emptyMap() else null,
    error = null,
    lastDiscoveredAt = null,
    updatedAt = null,
)

internal fun runtimeType(
    type: String,
    displayName: String = type.replaceFirstChar(Char::titlecase),
    policy: String = "multiple",
    maxInstances: Int? = null,
    present: Boolean = true,
    recommended: Boolean = false,
    rank: Int? = null,
    uiSchema: Map<String, Any?> = emptyMap(),
) = DeviceRuntimeType(
    connectorId = "device",
    type = type,
    displayName = displayName,
    present = present,
    recommended = recommended,
    recommendationRank = rank,
    schema = mapOf("type" to "object", "properties" to mapOf("codexHome" to mapOf("type" to "string"))),
    uiSchema = uiSchema,
    defaults = mapOf("ipcEnabled" to true),
    instancePolicy = policy,
    maxInstances = if (policy == "single") 1 else maxInstances,
)
