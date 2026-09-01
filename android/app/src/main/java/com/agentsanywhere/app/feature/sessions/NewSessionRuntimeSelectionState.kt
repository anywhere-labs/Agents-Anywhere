package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.api.RemoteRuntimeCapabilities
import com.agentsanywhere.app.api.RemoteRuntimeModelCatalogResponse
import com.agentsanywhere.app.api.RemoteRuntimePermissionCatalogResponse
import com.agentsanywhere.app.feature.devices.DeviceRuntime
import com.agentsanywhere.app.feature.devices.DeviceRuntimeList
import com.agentsanywhere.app.feature.devices.DeviceRuntimeStatus

const val MODEL_CATALOG_CAPABILITY = "catalog.model"
const val PERMISSION_CATALOG_CAPABILITY = "catalog.permission"

data class NewSessionRuntimeRequestKey(
    val connectorId: String,
    val runtimeId: String,
    val generation: Long,
)

data class NewSessionRuntimeScope(
    val connectorId: String,
    val runtimeId: String,
)

data class NewSessionSelections(
    val model: String? = null,
    val permission: String? = null,
) {
    fun toMap(): Map<String, String> = buildMap {
        model?.takeIf(String::isNotBlank)?.let { put("model", it) }
        permission?.takeIf(String::isNotBlank)?.let { put("permission", it) }
    }
}

data class NewSessionRuntimeCapabilities(
    val connectorId: String,
    val revision: Long,
    val capabilities: List<NewSessionRuntimeCapability>,
    val serverTime: String?,
) {
    fun find(
        capabilityId: String,
        runtimeId: String,
        runtimeType: String? = null,
    ): NewSessionRuntimeCapability? {
        val matches = capabilities.filter { it.capabilityId == capabilityId }
        return matches.firstOrNull { it.runtimeId == runtimeId }
            ?: matches.firstOrNull { it.runtimeId == null && it.runtime == runtimeId }
            ?: runtimeType?.let { expectedType ->
                matches.firstOrNull {
                    it.runtimeId == null && (it.runtimeType ?: it.runtime) == expectedType
                }
            }
            ?: matches.firstOrNull {
                it.runtimeId == null && it.runtimeType == null && it.runtime == null
            }
    }
}

data class NewSessionRuntimeCapability(
    val capabilityId: String,
    val version: String,
    val scope: String,
    val runtime: String?,
    val sessionId: String?,
    val supported: Boolean,
    val available: Boolean,
    val allowed: Boolean,
    val unavailableReason: String?,
    val parameters: Map<String, Any?>,
    val runtimeId: String? = null,
    val runtimeType: String? = runtime,
) {
    val usable: Boolean
        get() = supported && available && allowed
}

data class NewSessionModelCatalog(
    val runtime: String,
    val revision: Long,
    val models: List<NewSessionModel>,
    val serverTime: String?,
    val runtimeId: String = runtime,
    val runtimeType: String = runtime,
)

data class NewSessionModel(
    val id: String,
    val selectionId: String?,
    val displayName: String,
    val description: String?,
    val default: Boolean,
    val reasoningItems: List<NewSessionReasoning>,
    val metadata: Map<String, Any?>,
    val enabled: Boolean = true,
    val disabledReason: String? = null,
)

data class NewSessionReasoning(
    val id: String,
    val selectionId: String,
    val fullModelId: String?,
    val displayName: String,
    val description: String?,
    val default: Boolean,
    val metadata: Map<String, Any?>,
    val enabled: Boolean = true,
    val disabledReason: String? = null,
)

data class NewSessionPermissionCatalog(
    val runtime: String,
    val revision: Long,
    val permissions: List<NewSessionPermission>,
    val serverTime: String?,
    val runtimeId: String = runtime,
    val runtimeType: String = runtime,
)

data class NewSessionPermission(
    val id: String,
    val selectionId: String,
    val displayName: String,
    val description: String?,
    val default: Boolean,
    val metadata: Map<String, Any?>,
    val enabled: Boolean = true,
    val disabledReason: String? = null,
)

data class NewSessionRemoteData<T>(
    val data: T? = null,
    val loading: Boolean = false,
    val loaded: Boolean = false,
    val stale: Boolean = false,
    val errorMessage: String? = null,
    val unavailableReason: String? = null,
) {
    fun begin(retainData: Boolean): NewSessionRemoteData<T> {
        return if (retainData) {
            copy(loading = true, stale = false, errorMessage = null, unavailableReason = null)
        } else {
            NewSessionRemoteData(loading = true)
        }
    }

    fun succeed(value: T): NewSessionRemoteData<T> {
        return NewSessionRemoteData(data = value, loaded = true)
    }

    fun unavailable(reason: String?): NewSessionRemoteData<T> {
        return NewSessionRemoteData(loaded = true, unavailableReason = reason)
    }

    fun fail(message: String): NewSessionRemoteData<T> {
        return copy(
            loading = false,
            loaded = false,
            stale = data != null,
            errorMessage = message,
            unavailableReason = null,
        )
    }

    val fresh: Boolean
        get() = loaded && !loading && !stale && errorMessage == null
}

data class NewSessionRuntimeSelectionState(
    val connectorId: String? = null,
    val runtimes: List<DeviceRuntime> = emptyList(),
    val runtimesLoading: Boolean = false,
    val runtimesErrorMessage: String? = null,
    val selectedRuntimeId: String? = null,
    val generation: Long = 0L,
    val requestKey: NewSessionRuntimeRequestKey? = null,
    val capabilities: NewSessionRemoteData<NewSessionRuntimeCapabilities> = NewSessionRemoteData(),
    val modelCatalog: NewSessionRemoteData<NewSessionModelCatalog> = NewSessionRemoteData(),
    val permissionCatalog: NewSessionRemoteData<NewSessionPermissionCatalog> = NewSessionRemoteData(),
    val selectedModelId: String? = null,
    val selectedReasoningId: String? = null,
    val selectedPermissionId: String? = null,
    val selectionHints: Map<NewSessionRuntimeScope, NewSessionSelections> = emptyMap(),
) {
    val selectedRuntime: DeviceRuntime?
        get() = runtimes.firstOrNull { it.id == selectedRuntimeId }

    val selectedModel: NewSessionModel?
        get() = modelCatalog.data?.models?.firstOrNull { it.id == selectedModelId && it.enabled }

    val reasoningOptions: List<NewSessionReasoning>
        get() = selectedModel?.reasoningItems
            ?.filter { it.enabled && it.id.isNotBlank() && it.selectionId.isNotBlank() }
            .orEmpty()

    val selectedReasoning: NewSessionReasoning?
        get() = reasoningOptions.firstOrNull { it.id == selectedReasoningId }

    val selectedPermission: NewSessionPermission?
        get() = permissionCatalog.data?.permissions?.firstOrNull { it.id == selectedPermissionId && it.enabled }

    val selectedModelSelectionId: String?
        get() {
            val model = selectedModel ?: return null
            val reasoning = selectedReasoning
            if (reasoning != null) return reasoning.selectionId.takeIf(String::isNotBlank)
            if (model.reasoningItems.any { it.id.isNotBlank() && it.selectionId.isNotBlank() }) return null
            return model.selectionId?.takeIf(String::isNotBlank)
        }

    val selectedPermissionSelectionId: String?
        get() = selectedPermission?.selectionId?.takeIf(String::isNotBlank)

    val selections: NewSessionSelections
        get() = NewSessionSelections(
            model = selectedModelSelectionId,
            permission = selectedPermissionSelectionId,
        )

    val modelCapability: NewSessionRuntimeCapability?
        get() = selectedRuntime?.let { runtime ->
            capabilities.data?.find(MODEL_CATALOG_CAPABILITY, runtime.id, runtime.type)
        }

    val permissionCapability: NewSessionRuntimeCapability?
        get() = selectedRuntime?.let { runtime ->
            capabilities.data?.find(PERMISSION_CATALOG_CAPABILITY, runtime.id, runtime.type)
        }

    val canUseModelCatalog: Boolean
        get() = modelCapability?.usable == true

    val canUsePermissionCatalog: Boolean
        get() = permissionCapability?.usable == true

    val readyForCreate: Boolean
        get() {
            val runtime = selectedRuntime ?: return false
            if (!runtime.present || !runtime.configured || !runtime.active || runtime.status != DeviceRuntimeStatus.Running) {
                return false
            }
            if (!capabilities.fresh) return false
            if (canUseModelCatalog) {
                if (!modelCatalog.fresh) return false
                val hasModels = modelCatalog.data?.models?.any { it.enabled && it.hasValidSelection() } == true
                if (hasModels && selectedModelSelectionId == null) return false
            }
            if (canUsePermissionCatalog) {
                if (!permissionCatalog.fresh) return false
                val hasPermissions = permissionCatalog.data?.permissions
                    ?.any { it.enabled && it.id.isNotBlank() && it.selectionId.isNotBlank() } == true
                if (hasPermissions && selectedPermissionSelectionId == null) return false
            }
            return true
        }

    fun beginRuntimeInventory(connectorId: String): NewSessionRuntimeSelectionState {
        return if (this.connectorId == connectorId) {
            copy(runtimesLoading = true, runtimesErrorMessage = null)
        } else {
            NewSessionRuntimeSelectionState(
                connectorId = connectorId,
                runtimesLoading = true,
                generation = generation,
                selectionHints = selectionHints,
            )
        }
    }

    fun replaceRuntimeInventory(result: DeviceRuntimeList): NewSessionRuntimeSelectionState {
        if (result.connectorId != connectorId) return this
        val selectableRuntimes = result.runtimes.filter {
            it.configured && it.status == DeviceRuntimeStatus.Running
        }
        val nextRuntimeId = selectedRuntimeId
            ?.takeIf { selected -> selectableRuntimes.any { it.id == selected } }
            ?: selectableRuntimes.firstOrNull()?.id
        val base = copy(
            runtimes = selectableRuntimes,
            runtimesLoading = false,
            runtimesErrorMessage = null,
        )
        return if (nextRuntimeId == selectedRuntimeId) base else base.selectRuntime(nextRuntimeId)
    }

    fun failRuntimeInventory(connectorId: String, message: String): NewSessionRuntimeSelectionState {
        if (this.connectorId != connectorId) return this
        return copy(runtimesLoading = false, runtimesErrorMessage = message)
    }

    fun selectRuntime(runtimeId: String?): NewSessionRuntimeSelectionState {
        if (runtimeId == selectedRuntimeId) return this
        val nextHints = rememberCurrentSelections()
        return copy(
            selectedRuntimeId = runtimeId,
            requestKey = null,
            capabilities = NewSessionRemoteData(),
            modelCatalog = NewSessionRemoteData(),
            permissionCatalog = NewSessionRemoteData(),
            selectedModelId = null,
            selectedReasoningId = null,
            selectedPermissionId = null,
            selectionHints = nextHints,
        )
    }

    fun beginRuntimeDetails(): NewSessionRuntimeSelectionState {
        val currentConnectorId = connectorId ?: return this
        val runtimeId = selectedRuntimeId ?: return this
        val nextGeneration = generation + 1L
        val retainData = requestKey?.connectorId == currentConnectorId &&
            requestKey.runtimeId == runtimeId
        return copy(
            generation = nextGeneration,
            requestKey = NewSessionRuntimeRequestKey(currentConnectorId, runtimeId, nextGeneration),
            capabilities = capabilities.begin(retainData),
            modelCatalog = modelCatalog.begin(retainData),
            permissionCatalog = permissionCatalog.begin(retainData),
            selectionHints = rememberCurrentSelections(),
        )
    }

    fun applyCapabilities(
        key: NewSessionRuntimeRequestKey,
        value: NewSessionRuntimeCapabilities,
    ): NewSessionRuntimeSelectionState {
        if (requestKey != key) return this
        val runtimeType = selectedRuntime?.type
        val modelCapability = value.find(MODEL_CATALOG_CAPABILITY, key.runtimeId, runtimeType)
        val permissionCapability = value.find(PERMISSION_CATALOG_CAPABILITY, key.runtimeId, runtimeType)
        return copy(
            capabilities = capabilities.succeed(value),
            modelCatalog = if (modelCapability?.usable == true) {
                modelCatalog.copy(loading = true, errorMessage = null, unavailableReason = null)
            } else {
                NewSessionRemoteData<NewSessionModelCatalog>().unavailable(modelCapability?.unavailableReason)
            },
            permissionCatalog = if (permissionCapability?.usable == true) {
                permissionCatalog.copy(loading = true, errorMessage = null, unavailableReason = null)
            } else {
                NewSessionRemoteData<NewSessionPermissionCatalog>().unavailable(permissionCapability?.unavailableReason)
            },
            selectedModelId = if (modelCapability?.usable == true) selectedModelId else null,
            selectedReasoningId = if (modelCapability?.usable == true) selectedReasoningId else null,
            selectedPermissionId = if (permissionCapability?.usable == true) selectedPermissionId else null,
        )
    }

    fun failCapabilities(
        key: NewSessionRuntimeRequestKey,
        message: String,
    ): NewSessionRuntimeSelectionState {
        if (requestKey != key) return this
        return copy(
            capabilities = capabilities.fail(message),
            modelCatalog = modelCatalog.fail(message),
            permissionCatalog = permissionCatalog.fail(message),
        )
    }

    fun applyModelCatalog(
        key: NewSessionRuntimeRequestKey,
        value: NewSessionModelCatalog,
    ): NewSessionRuntimeSelectionState {
        if (requestKey != key) return this
        val hint = selectionHints[NewSessionRuntimeScope(key.connectorId, key.runtimeId)]?.model
            ?: selectedModelSelectionId
        val selection = value.defaultSelection(hint)
        val next = copy(
            modelCatalog = modelCatalog.succeed(value),
            selectedModelId = selection?.modelId,
            selectedReasoningId = selection?.reasoningId,
        )
        return next.copy(selectionHints = next.rememberCurrentSelections())
    }

    fun failModelCatalog(
        key: NewSessionRuntimeRequestKey,
        message: String,
    ): NewSessionRuntimeSelectionState {
        if (requestKey != key) return this
        return copy(modelCatalog = modelCatalog.fail(message))
    }

    fun applyPermissionCatalog(
        key: NewSessionRuntimeRequestKey,
        value: NewSessionPermissionCatalog,
    ): NewSessionRuntimeSelectionState {
        if (requestKey != key) return this
        val hint = selectionHints[NewSessionRuntimeScope(key.connectorId, key.runtimeId)]?.permission
            ?: selectedPermissionSelectionId
        val selected = value.permissions.firstOrNull {
            it.enabled && it.selectionId.isNotBlank() && it.selectionId == hint
        } ?: value.permissions.firstOrNull {
            it.enabled && it.id.isNotBlank() && it.selectionId.isNotBlank() && it.default
        } ?: value.permissions.firstOrNull {
            it.enabled && it.id.isNotBlank() && it.selectionId.isNotBlank()
        }
        val next = copy(
            permissionCatalog = permissionCatalog.succeed(value),
            selectedPermissionId = selected?.id,
        )
        return next.copy(selectionHints = next.rememberCurrentSelections())
    }

    fun failPermissionCatalog(
        key: NewSessionRuntimeRequestKey,
        message: String,
    ): NewSessionRuntimeSelectionState {
        if (requestKey != key) return this
        return copy(permissionCatalog = permissionCatalog.fail(message))
    }

    fun selectModel(modelId: String): NewSessionRuntimeSelectionState {
        val model = modelCatalog.data?.models?.firstOrNull {
            it.id == modelId && it.enabled && it.hasValidSelection()
        } ?: return this
        val reasoningId = model.reasoningItems.firstOrNull {
            it.enabled && it.id.isNotBlank() && it.selectionId.isNotBlank() && it.default
        }?.id ?: model.reasoningItems.firstOrNull {
            it.enabled && it.id.isNotBlank() && it.selectionId.isNotBlank()
        }?.id
        val next = copy(selectedModelId = model.id, selectedReasoningId = reasoningId)
        return next.copy(selectionHints = next.rememberCurrentSelections())
    }

    fun selectReasoning(reasoningId: String): NewSessionRuntimeSelectionState {
        if (reasoningOptions.none { it.id == reasoningId }) return this
        val next = copy(selectedReasoningId = reasoningId)
        return next.copy(selectionHints = next.rememberCurrentSelections())
    }

    fun selectPermission(permissionId: String): NewSessionRuntimeSelectionState {
        val valid = permissionCatalog.data?.permissions?.any {
            it.enabled && it.id == permissionId && it.selectionId.isNotBlank()
        } == true
        if (!valid) return this
        val next = copy(selectedPermissionId = permissionId)
        return next.copy(selectionHints = next.rememberCurrentSelections())
    }

    private fun rememberCurrentSelections(): Map<NewSessionRuntimeScope, NewSessionSelections> {
        val currentConnectorId = connectorId ?: return selectionHints
        val runtimeId = selectedRuntimeId ?: return selectionHints
        val current = selections
        if (current.model == null && current.permission == null) return selectionHints
        return selectionHints + (NewSessionRuntimeScope(currentConnectorId, runtimeId) to current)
    }
}

private data class ModelSelection(
    val modelId: String,
    val reasoningId: String?,
)

private fun NewSessionModelCatalog.defaultSelection(hint: String?): ModelSelection? {
    if (!hint.isNullOrBlank()) {
        models.filter { it.enabled }.forEach { model ->
            val validReasoning = model.reasoningItems.filter {
                it.enabled && it.id.isNotBlank() && it.selectionId.isNotBlank()
            }
            validReasoning.firstOrNull { it.selectionId == hint }?.let {
                return ModelSelection(model.id, it.id)
            }
            if (!model.hasReasoningSelections() && model.selectionId == hint && model.id.isNotBlank()) {
                return ModelSelection(model.id, null)
            }
        }
    }
    models.filter { it.enabled }.forEach { model ->
        model.reasoningItems.firstOrNull {
            it.enabled && it.id.isNotBlank() && it.selectionId.isNotBlank() && it.default
        }?.let { return ModelSelection(model.id, it.id) }
    }
    models.firstOrNull { it.enabled && it.id.isNotBlank() && it.default && it.hasValidSelection() }?.let { model ->
        val reasoning = model.reasoningItems.firstOrNull {
            it.enabled && it.id.isNotBlank() && it.selectionId.isNotBlank()
        }
        return ModelSelection(model.id, reasoning?.id)
    }
    models.firstOrNull { it.enabled && it.id.isNotBlank() && it.hasValidSelection() }?.let { model ->
        val reasoning = model.reasoningItems.firstOrNull {
            it.enabled && it.id.isNotBlank() && it.selectionId.isNotBlank()
        }
        return ModelSelection(model.id, reasoning?.id)
    }
    return null
}

private fun NewSessionModel.hasValidSelection(): Boolean {
    return if (hasReasoningSelections()) {
        reasoningItems.any { it.enabled && it.id.isNotBlank() && it.selectionId.isNotBlank() }
    } else {
        selectionId?.isNotBlank() == true
    }
}

private fun NewSessionModel.hasReasoningSelections(): Boolean {
    return reasoningItems.any { it.id.isNotBlank() && it.selectionId.isNotBlank() }
}

internal fun RemoteRuntimeCapabilities.toNewSessionRuntimeCapabilities(): NewSessionRuntimeCapabilities {
    return NewSessionRuntimeCapabilities(
        connectorId = connectorId,
        revision = capabilitySet.revision,
        capabilities = capabilitySet.capabilities.map {
            NewSessionRuntimeCapability(
                capabilityId = it.capabilityId,
                version = it.version,
                scope = it.scope,
                runtime = it.runtime,
                sessionId = it.sessionId,
                supported = it.supported,
                available = it.available,
                allowed = it.allowed,
                unavailableReason = it.unavailableReason,
                parameters = it.parameters,
                runtimeId = it.runtimeId,
                runtimeType = it.runtimeType,
            )
        },
        serverTime = serverTime,
    )
}

internal fun RemoteRuntimeModelCatalogResponse.toNewSessionModelCatalog(): NewSessionModelCatalog {
    return NewSessionModelCatalog(
        runtime = catalog.runtime,
        revision = catalog.revision,
        models = catalog.models.map { model ->
            NewSessionModel(
                id = model.id,
                selectionId = model.selectionId,
                displayName = model.displayName,
                description = model.description,
                default = model.default,
                reasoningItems = model.reasoningItems.map {
                    NewSessionReasoning(
                        id = it.id,
                        selectionId = it.selectionId,
                        fullModelId = it.fullModelId,
                        displayName = it.displayName,
                        description = it.description,
                        default = it.default,
                        metadata = it.metadata,
                        enabled = it.enabled,
                        disabledReason = it.disabledReason,
                    )
                },
                metadata = model.metadata,
                enabled = model.enabled,
                disabledReason = model.disabledReason,
            )
        },
        serverTime = serverTime,
        runtimeId = catalog.runtimeId,
        runtimeType = catalog.runtimeType,
    )
}

internal fun RemoteRuntimePermissionCatalogResponse.toNewSessionPermissionCatalog(): NewSessionPermissionCatalog {
    return NewSessionPermissionCatalog(
        runtime = catalog.runtime,
        revision = catalog.revision,
        permissions = catalog.permissions.map {
            NewSessionPermission(
                id = it.id,
                selectionId = it.selectionId,
                displayName = it.displayName,
                description = it.description,
                default = it.default,
                metadata = it.metadata,
                enabled = it.enabled,
                disabledReason = it.disabledReason,
            )
        },
        serverTime = serverTime,
        runtimeId = catalog.runtimeId,
        runtimeType = catalog.runtimeType,
    )
}
