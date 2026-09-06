package com.agentsanywhere.app.ui.screens.home

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.agentsanywhere.app.feature.devices.DeviceRuntimeList
import com.agentsanywhere.app.feature.sessions.activeNewSessionRuntimes
import com.agentsanywhere.app.feature.sessions.newSessionInventoryNeedsSettling
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

internal class NewSessionRuntimeInventory {
    var results by mutableStateOf<Map<String, DeviceRuntimeList>>(emptyMap())
    var errors by mutableStateOf<Map<String, String>>(emptyMap())
    var pendingInitial by mutableStateOf<Set<String>>(emptySet())
    var hasLoaded by mutableStateOf(false)
    var refreshVersion by mutableStateOf(0L)
        private set

    val loading: Boolean
        get() = !hasLoaded || (pendingInitial.isNotEmpty() && results.values.none { activeNewSessionRuntimes(it.runtimes).isNotEmpty() })

    fun refresh() { refreshVersion++ }
}

@Composable
internal fun rememberNewSessionRuntimeInventory(
    connectorIds: List<String>,
    onLoad: suspend (String) -> Result<DeviceRuntimeList>,
    loadError: String,
): NewSessionRuntimeInventory {
    val inventory = remember { NewSessionRuntimeInventory() }
    val load by rememberUpdatedState(onLoad)
    val fallbackError by rememberUpdatedState(loadError)
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var visible by remember(lifecycle) { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, _ -> visible = lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val ids = connectorIds.distinct().sorted()
    LaunchedEffect(ids, inventory.refreshVersion, visible) {
        if (!visible) return@LaunchedEffect
        inventory.results = inventory.results.filterKeys { it in ids }
        inventory.errors = inventory.errors.filterKeys { it in ids }
        inventory.pendingInitial = ids.toSet()
        if (ids.isEmpty()) inventory.hasLoaded = true
        coroutineScope {
            ids.forEach { id -> launch {
                var attempt = 0
                while (true) {
                    val result = try {
                        load(id)
                    } catch (error: CancellationException) {
                        throw error
                    } catch (error: Exception) {
                        Result.failure(error)
                    }
                    currentCoroutineContext().ensureActive()
                    result.onSuccess { value ->
                        inventory.results = inventory.results + (id to value)
                        inventory.errors = inventory.errors - id
                    }.onFailure { error ->
                        if (error is CancellationException) throw error
                        inventory.errors = inventory.errors + (id to (error.message ?: fallbackError))
                    }
                    inventory.pendingInitial = inventory.pendingInitial - id
                    if (inventory.pendingInitial.isEmpty()) inventory.hasLoaded = true
                    val settling = result.getOrNull()?.let { newSessionInventoryNeedsSettling(it.runtimes) } ?: true
                    val retryDelay = RECONNECT_DELAYS.getOrNull(attempt++)
                    if (!settling || retryDelay == null) break
                    delay(retryDelay)
                }
            } }
        }
    }
    return inventory
}

private val RECONNECT_DELAYS = listOf(500L, 1_000L, 2_000L, 4_000L, 8_000L)
