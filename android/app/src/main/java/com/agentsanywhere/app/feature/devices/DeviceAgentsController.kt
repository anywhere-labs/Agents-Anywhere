package com.agentsanywhere.app.feature.devices

import com.agentsanywhere.app.api.ApiException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.io.IOException

data class DeviceAgentsState(
    val inventory: DeviceAgentInventory,
    val loaded: Boolean = false,
    val loading: Boolean = false,
    val discovering: Boolean = false,
    /** Instance or type an Agent operation is working on; one runs at a time. */
    val busyId: String? = null,
    /** Set only while nothing has loaded yet; later failures are reported to the caller instead. */
    val loadFailed: Boolean = false,
    val loadErrorMessage: String? = null,
) {
    val busy: Boolean
        get() = busyId != null

    val configuredRuntimes: List<DeviceRuntime>
        get() = inventory.configuredRuntimes

    val addableTypes: List<DeviceRuntimeType>
        get() = inventory.addableTypes
}

/** Thrown when an Agent operation starts while another one is still running. */
class DeviceAgentBusyException : IllegalStateException("Another Agent operation is still running.")

/**
 * Agent management for one device, shared by the device page and the setup sheet.
 * A refresh that finishes after a newer refresh or an operation started is discarded.
 */
class DeviceAgentsController(
    val connectorId: String,
    private val operations: DeviceAgentOperations,
) {
    private val mutableState = MutableStateFlow(DeviceAgentsState(inventory = DeviceAgentInventory(connectorId)))
    val state: StateFlow<DeviceAgentsState> = mutableState.asStateFlow()
    private var generation = 0L

    /**
     * [quiet] follows status changes in the background without showing a refresh.
     * Before anything has loaded, a transient failure is retried after each of [retryDelays].
     */
    suspend fun refresh(
        discover: Boolean = false,
        quiet: Boolean = false,
        retryDelays: List<Long> = emptyList(),
    ): Result<Unit> {
        if (state.value.busy) return Result.failure(DeviceAgentBusyException())
        if (quiet && (state.value.loading || state.value.discovering)) return Result.success(Unit)
        val current = ++generation
        if (!quiet) {
            mutableState.update {
                it.copy(loading = !discover || !it.loaded, discovering = discover, loadFailed = false, loadErrorMessage = null)
            }
        }
        var result = try {
            loadInventory(discover, keepTypes = quiet)
        } catch (error: CancellationException) {
            settleCancelledRefresh(current)
            throw error
        }
        for (wait in retryDelays) {
            val error = result.exceptionOrNull() ?: break
            if (state.value.loaded || !error.isTransientAgentFailure() || current != generation) break
            try {
                delay(wait)
                if (current != generation) break
                result = loadInventory(discover)
            } catch (cancelled: CancellationException) {
                settleCancelledRefresh(current)
                throw cancelled
            }
        }
        if (current != generation) return result.map { }
        mutableState.update { state ->
            result.fold(
                onSuccess = { inventory ->
                    state.copy(inventory = inventory, loaded = true, loading = false, discovering = false)
                },
                onFailure = { error ->
                    if (quiet) {
                        state
                    } else {
                        state.copy(
                            loading = false,
                            discovering = false,
                            loadFailed = !state.loaded,
                            loadErrorMessage = error.message.takeIf { !state.loaded },
                        )
                    }
                },
            )
        }
        return result.map { }
    }

    /** Adds [type], or continues the instance an earlier attempt left behind. */
    suspend fun add(type: DeviceRuntimeType, request: DeviceRuntimeAddRequest): Result<DeviceRuntime> = perform(type.type) {
        addDeviceRuntime(operations, connectorId, type, request, onRuntimeUpdated = ::replace)
    }

    suspend fun saveConfig(runtime: DeviceRuntime, config: Map<String, Any?>): Result<DeviceRuntime> = perform(runtime.id) {
        operations.saveDeviceRuntimeConfig(connectorId, runtime.id, config).getOrThrow().also(::replace)
    }

    suspend fun rename(runtime: DeviceRuntime, name: String): Result<DeviceRuntime> = perform(runtime.id) {
        operations.renameDeviceRuntime(connectorId, runtime.id, name.trim()).getOrThrow().also(::replace)
    }

    suspend fun setActive(runtime: DeviceRuntime, active: Boolean): Result<DeviceRuntime> = perform(runtime.id) {
        operations.setDeviceRuntimeActive(connectorId, runtime.id, active).getOrThrow().also(::replace)
    }

    suspend fun delete(runtime: DeviceRuntime): Result<DeviceRuntime> = perform(runtime.id) {
        operations.deleteDeviceRuntimeConfig(connectorId, runtime.id).getOrThrow().also { response ->
            mutableState.update { state ->
                state.copy(inventory = state.inventory.copy(runtimes = state.inventory.runtimes.afterRuntimeDeletion(runtime.id, response)))
            }
        }
    }

    /**
     * Runs one write, then reads the inventory again: a failed start may still have
     * created or changed the instance, so retries always see the Server's state.
     */
    private suspend fun perform(id: String, action: suspend () -> DeviceRuntime): Result<DeviceRuntime> {
        if (state.value.busy) return Result.failure(DeviceAgentBusyException())
        generation++
        mutableState.update { it.copy(busyId = id, loading = false, discovering = false) }
        try {
            val result = try {
                Result.success(action())
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                Result.failure(error)
            }
            val current = ++generation
            val refreshed = loadInventory(discover = false)
            mutableState.update { state ->
                val inventory = refreshed.getOrNull()?.takeIf { current == generation } ?: state.inventory
                state.copy(inventory = inventory, loaded = state.loaded || refreshed.isSuccess)
            }
            return result
        } finally {
            // Also after cancellation, so a page that stopped waiting never stays locked.
            mutableState.update { it.copy(busyId = null) }
        }
    }

    private fun settleCancelledRefresh(current: Long) {
        if (current == generation) mutableState.update { it.copy(loading = false, discovering = false) }
    }

    private fun replace(runtime: DeviceRuntime) {
        mutableState.update { state ->
            state.copy(inventory = state.inventory.copy(runtimes = state.inventory.runtimes.withRuntime(runtime)))
        }
    }

    /**
     * Discovery asks the Connector first, then reads instances it may have created or
     * changed. [keepTypes] only follows instance status and reuses the types already read.
     */
    private suspend fun loadInventory(discover: Boolean, keepTypes: Boolean = false): Result<DeviceAgentInventory> = try {
        val types = if (keepTypes && state.value.loaded) {
            state.value.inventory.types
        } else {
            operations.listDeviceRuntimeTypes(connectorId, discover).getOrThrow()
        }
        val runtimes = operations.listDeviceRuntimes(connectorId).getOrThrow().runtimes
        Result.success(DeviceAgentInventory(connectorId, types, runtimes))
    } catch (error: CancellationException) {
        throw error
    } catch (error: Exception) {
        Result.failure(error)
    }
}

/** Failures a Connector that just came online reports while it is still starting up. */
internal fun Throwable.isTransientAgentFailure(): Boolean {
    val status = (this as? ApiException)?.statusCode ?: return cause is IOException || this is IOException
    return status == 0 || status == 408 || status == 409 || status == 425 || status == 429 || status >= 500
}
