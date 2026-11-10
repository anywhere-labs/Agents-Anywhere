package com.agentsanywhere.app.ui.screens.devices

import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.devices.DeviceAgentBusyException
import com.agentsanywhere.app.feature.devices.DeviceAgentOperations
import com.agentsanywhere.app.feature.devices.DeviceAgentsController
import com.agentsanywhere.app.feature.devices.DeviceRuntime
import com.agentsanywhere.app.feature.devices.DeviceRuntimeAddPlan
import com.agentsanywhere.app.feature.devices.DeviceRuntimeAddRequest
import com.agentsanywhere.app.feature.devices.DeviceRuntimeMissingException
import com.agentsanywhere.app.feature.devices.DeviceRuntimeStatus
import com.agentsanywhere.app.feature.devices.DeviceRuntimeType
import com.agentsanywhere.app.feature.devices.DeviceRuntimeTypeUnavailableException
import com.agentsanywhere.app.feature.devices.RuntimeConfigForm
import com.agentsanywhere.app.feature.devices.configRequiredFields
import com.agentsanywhere.app.feature.devices.runtimeNameKey
import com.agentsanywhere.app.ui.designsystem.runtimeErrorText
import com.agentsanywhere.app.ui.designsystem.runtimeOperationErrorMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private val settlingStatuses = setOf(
    DeviceRuntimeStatus.Starting,
    DeviceRuntimeStatus.Stopping,
    DeviceRuntimeStatus.Validating,
    DeviceRuntimeStatus.Discovering,
)

/**
 * Loads the device's Agents and keeps them current while the caller is shown: saved
 * Agents load even when the device is offline, discovery waits for it to be online.
 */
@Composable
internal fun rememberDeviceAgentsController(
    connectorId: String,
    online: Boolean,
    operations: DeviceAgentOperations,
    discoverOnOpen: Boolean = false,
): DeviceAgentsController {
    val controller = remember(connectorId, operations) { DeviceAgentsController(connectorId, operations) }
    val state by controller.state.collectAsState()
    LaunchedEffect(controller, online) {
        if (controller.state.value.loaded && !online) return@LaunchedEffect
        // A Connector that has just come online may still refuse discovery for a moment.
        controller.refresh(discover = discoverOnOpen && online, retryDelays = listOf(500L, 1_000L, 2_000L))
    }
    // Android receives no runtime pushes, so a starting or stopping Agent is followed until it settles.
    val settling = online && state.configuredRuntimes.any { it.status in settlingStatuses }
    LaunchedEffect(controller, settling) {
        var wait = 2_000L
        while (settling) {
            delay(wait)
            controller.refresh(quiet = true)
            wait = (wait * 3 / 2).coerceAtMost(10_000L)
        }
    }
    return controller
}

private sealed interface AgentConfiguration {
    data class Existing(val runtime: DeviceRuntime, val form: RuntimeConfigForm) : AgentConfiguration
    data class New(
        val type: DeviceRuntimeType,
        val plan: DeviceRuntimeAddPlan,
        val form: RuntimeConfigForm,
        /** An instance an earlier failed attempt created, so the retry continues with it. */
        val runtimeId: String?,
    ) : AgentConfiguration
}

/**
 * Agent list with its add, configure, rename, start and delete flows. [onMessage] shows a
 * toast. Pass the page's [scope] when the panel sits in a lazy list, so scrolling it out of
 * view does not cancel a running operation.
 */
@Composable
internal fun DeviceAgentsPanel(
    controller: DeviceAgentsController,
    online: Boolean,
    onMessage: (message: String, isError: Boolean) -> Unit,
    scope: CoroutineScope = rememberCoroutineScope(),
) {
    val context = LocalContext.current
    val state by controller.state.collectAsState()
    var configuring by remember(controller) { mutableStateOf<AgentConfiguration?>(null) }
    var actionsFor by remember(controller) { mutableStateOf<String?>(null) }
    var deleting by remember(controller) { mutableStateOf<DeviceRuntime?>(null) }
    var deleteBusy by remember(controller) { mutableStateOf(false) }
    var deleteError by remember(controller) { mutableStateOf<String?>(null) }
    // A failed quick add retries under the same name, so it continues with any instance it created.
    var quickAddNames by remember(controller) { mutableStateOf(emptyMap<String, String>()) }
    val nameTaken = stringResource(R.string.device_agents_name_taken)

    fun failureText(error: Throwable, @StringRes fallback: Int): String = when (error) {
        is DeviceAgentBusyException -> context.getString(R.string.device_agents_busy)
        is DeviceRuntimeMissingException -> context.getString(R.string.device_agents_instance_missing)
        is DeviceRuntimeTypeUnavailableException -> context.getString(R.string.device_agents_type_unavailable)
        else -> runtimeOperationErrorMessage(context, error, fallback)
    }

    fun added(runtime: DeviceRuntime) =
        onMessage(context.getString(R.string.device_agents_added, runtime.labels.primary), false)

    fun quickAdd(type: DeviceRuntimeType) {
        val plan = state.inventory.addPlan(type, continuing = quickAddNames[type.type])
        val name = plan.name
        scope.launch {
            controller.add(type, DeviceRuntimeAddRequest(name = name, runtimeId = plan.runtimeId))
                .onSuccess { runtime ->
                    quickAddNames = quickAddNames - type.type
                    added(runtime)
                }
                .onFailure { error ->
                    quickAddNames = quickAddNames + (type.type to name)
                    onMessage(failureText(error, R.string.device_agents_add_failed), true)
                }
        }
    }

    fun configureType(type: DeviceRuntimeType) {
        // Configuring after a failed quick add continues the instance it created.
        val plan = state.inventory.addPlan(type, continuing = quickAddNames[type.type])
        val form = RuntimeConfigForm.from(type.schema, type.uiSchema, type.defaults, plan.requiredFields)
        if (form == null) {
            onMessage(context.getString(R.string.device_agents_schema_unavailable), true)
        } else {
            configuring = AgentConfiguration.New(type, plan, form, plan.runtimeId)
        }
    }

    fun configure(runtime: DeviceRuntime) {
        actionsFor = null
        scope.launch {
            var target = runtime
            if (runtime.type == "dsh" && online) {
                // DSH reports its current modes only through discovery.
                controller.refresh(discover = true)
                    .onFailure { onMessage(failureText(it, R.string.device_agents_discover_failed), true) }
                target = controller.state.value.inventory.runtimes.firstOrNull { it.id == runtime.id } ?: runtime
            }
            val form = RuntimeConfigForm.from(target.schema, target.uiSchema, target.defaults, target.configRequiredFields())
            if (form == null) {
                onMessage(context.getString(R.string.device_agents_schema_unavailable), true)
            } else {
                configuring = AgentConfiguration.Existing(target, form)
            }
        }
    }

    fun setActive(runtime: DeviceRuntime, active: Boolean) {
        scope.launch {
            controller.setActive(runtime, active).onFailure { error ->
                // A failed start records a new reason on the instance, which says more than the request error.
                val reason = controller.state.value.inventory.runtimes
                    .firstOrNull { it.id == runtime.id && it.error != null && it.error != runtime.error }
                    ?.let { runtimeErrorText(context, it.errorCode, it.errorMessage) }
                onMessage(reason ?: failureText(error, R.string.device_runtime_update_failed), true)
            }
        }
    }

    DeviceAgentsSection(
        state = state,
        online = online,
        onDiscover = {
            scope.launch {
                controller.refresh(discover = true)
                    .onFailure { onMessage(failureText(it, R.string.device_agents_discover_failed), true) }
            }
        },
        onRetry = { scope.launch { controller.refresh() } },
        onQuickAdd = ::quickAdd,
        onConfigureType = ::configureType,
        onConfigure = ::configure,
        onMore = { actionsFor = it.id },
        onSetActive = ::setActive,
    )

    when (val current = configuring) {
        is AgentConfiguration.Existing -> DeviceRuntimeConfigureSheet(
            title = stringResource(R.string.runtime_config_title, current.runtime.labels.primary),
            form = current.form,
            config = current.runtime.config,
            submitLabel = stringResource(R.string.common_save),
            online = online,
            onDismiss = { configuring = null },
            onSubmit = { _, config ->
                controller.saveConfig(current.runtime, config).fold(
                    onSuccess = { runtime ->
                        configuring = null
                        onMessage(context.getString(R.string.device_agents_saved, runtime.labels.primary), false)
                        null
                    },
                    onFailure = { failureText(it, R.string.device_agents_save_failed) },
                )
            },
        )
        is AgentConfiguration.New -> DeviceRuntimeConfigureSheet(
            title = stringResource(R.string.runtime_config_title, current.type.displayName),
            form = current.form,
            config = current.plan.config,
            submitLabel = stringResource(R.string.runtime_config_configure_and_start),
            online = online,
            instanceName = current.plan.name,
            validateName = { if (current.plan.nameTaken(it)) nameTaken else null },
            onDismiss = { configuring = null },
            onSubmit = { name, config ->
                controller.add(current.type, DeviceRuntimeAddRequest(name = name, config = config, runtimeId = current.runtimeId)).fold(
                    onSuccess = { runtime ->
                        configuring = null
                        quickAddNames = quickAddNames - current.type.type
                        added(runtime)
                        null
                    },
                    onFailure = { error ->
                        controller.state.value.inventory.runtimes
                            .firstOrNull { it.type == current.type.type && name != null && runtimeNameKey(it.name) == runtimeNameKey(name) }
                            ?.let { configuring = current.copy(runtimeId = it.id) }
                        failureText(error, R.string.device_agents_add_failed)
                    },
                )
            },
        )
        null -> Unit
    }

    actionsFor?.let { id -> state.inventory.runtimes.firstOrNull { it.id == id } }?.let { runtime ->
        DeviceRuntimeActionsSheet(
            runtime = runtime,
            online = online,
            validateName = { name ->
                val taken = state.inventory.runtimes.any { it.id != runtime.id && runtimeNameKey(it.name) == runtimeNameKey(name) }
                if (taken) nameTaken else null
            },
            onDismiss = { actionsFor = null },
            onConfigure = { configure(runtime) },
            onRename = { name ->
                controller.rename(runtime, name).fold(
                    onSuccess = { null },
                    onFailure = { failureText(it, R.string.device_agents_rename_failed) },
                )
            },
            onDelete = {
                actionsFor = null
                deleteError = null
                deleting = runtime
            },
        )
    }

    deleting?.let { runtime ->
        DeviceConfirmDialog(
            action = DeviceConfirmAction.DeleteRuntimeConfig(runtime),
            busy = deleteBusy,
            errorMessage = deleteError,
            onDismiss = {
                if (!deleteBusy) {
                    deleting = null
                    deleteError = null
                }
            },
            onConfirm = {
                if (!deleteBusy) {
                    deleteBusy = true
                    deleteError = null
                    scope.launch {
                        controller.delete(runtime)
                            .onSuccess { deleting = null }
                            .onFailure { deleteError = failureText(it, R.string.device_runtime_delete_failed) }
                        deleteBusy = false
                    }
                }
            },
        )
    }
}
