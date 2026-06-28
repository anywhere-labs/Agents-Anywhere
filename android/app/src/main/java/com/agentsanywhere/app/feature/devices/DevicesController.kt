package com.agentsanywhere.app.feature.devices

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.DevicesApi
import com.agentsanywhere.app.api.RemoteDevice
import com.agentsanywhere.app.api.RemoteRuntimeConfigField
import com.agentsanywhere.app.api.RemoteRuntimeConfigOption
import com.agentsanywhere.app.api.RemoteRuntimeConfigSchema
import com.agentsanywhere.app.api.RemoteRuntimeSettings
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import com.agentsanywhere.app.feature.sessiondetail.RuntimeConfigField
import com.agentsanywhere.app.feature.sessiondetail.RuntimeConfigOption
import com.agentsanywhere.app.feature.sessiondetail.RuntimeConfigSchema
import com.agentsanywhere.app.feature.sessiondetail.RuntimeSettingsState
import com.agentsanywhere.app.model.AgentDevice
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class DevicesController(
    private val devicesApi: DevicesApi,
    private val sessionStore: AuthSessionStore,
    private val sessionsApi: SessionsApi = SessionsApi(),
) {
    suspend fun renameDevice(
        connectorId: String,
        name: String,
    ): Result<AgentDevice> {
        val auth = authSession()
            ?: return Result.failure(IllegalStateException("Sign in again to rename this device."))

        return withContext(Dispatchers.IO) {
            runCatching {
                devicesApi.updateDevice(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = connectorId,
                    name = name,
                ).toAgentDevice()
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not rename device.", error)
            }
        }
    }

    suspend fun deleteDevice(connectorId: String): Result<Unit> {
        val auth = authSession()
            ?: return Result.failure(IllegalStateException("Sign in again to delete this device."))

        return withContext(Dispatchers.IO) {
            runCatching {
                devicesApi.deleteDevice(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = connectorId,
                )
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not delete device.", error)
            }
        }
    }

    suspend fun createDeviceSetup(name: String): Result<DeviceSetupCredential> {
        val auth = authSession()
            ?: return Result.failure(IllegalStateException("Sign in again to pair a new device."))
        val cleanName = name.trim().ifBlank { "Device" }

        return withContext(Dispatchers.IO) {
            runCatching {
                val credential = devicesApi.createDevice(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    name = cleanName,
                )
                DeviceSetupCredential(
                    device = credential.device.toAgentDevice(),
                    serverUrl = auth.serverUrl.trimEnd('/'),
                    connectorToken = credential.deviceToken,
                )
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not generate connector token.", error)
            }
        }
    }

    suspend fun prepareDeviceSetup(connectorId: String): Result<DeviceSetupCredential> {
        val auth = authSession()
            ?: return Result.failure(IllegalStateException("Sign in again to set up this device."))

        return withContext(Dispatchers.IO) {
            runCatching {
                val credential = devicesApi.revokeDevice(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = connectorId,
                )
                DeviceSetupCredential(
                    device = credential.device.toAgentDevice(),
                    serverUrl = auth.serverUrl.trimEnd('/'),
                    connectorToken = credential.deviceToken,
                )
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not prepare device setup.", error)
            }
        }
    }

    suspend fun claimDevicePairCode(
        credential: DeviceSetupCredential,
        code: String,
    ): Result<AgentDevice> {
        val auth = authSession()
            ?: return Result.failure(IllegalStateException("Sign in again to claim this pair code."))
        val cleanCode = code.trim().uppercase()
        if (cleanCode.isBlank()) {
            return Result.failure(IllegalArgumentException("Enter the code shown by uvx anywhere-cli pair."))
        }

        return withContext(Dispatchers.IO) {
            runCatching {
                devicesApi.claimPairing(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    code = cleanCode,
                    name = credential.device.name,
                    deviceId = credential.device.id,
                    deviceToken = credential.connectorToken,
                ).toAgentDevice()
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not claim pairing code.", error)
            }
        }
    }

    suspend fun deleteDeviceAgent(
        connectorId: String,
        runtime: String,
    ): Result<List<String>> {
        val auth = authSession()
            ?: return Result.failure(IllegalStateException("Sign in again to remove this agent."))

        return withContext(Dispatchers.IO) {
            runCatching {
                devicesApi.deleteDeviceRuntime(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = connectorId,
                    runtime = runtime,
                )
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not remove agent.", error)
            }
        }
    }

    suspend fun scanDeviceAgent(
        connectorId: String,
        runtime: String,
        path: String,
    ): Result<DeviceAgentScanResult> {
        val auth = authSession()
            ?: return Result.failure(IllegalStateException("Sign in again to add this agent."))

        return withContext(Dispatchers.IO) {
            runCatching {
                val scan = devicesApi.scanDeviceRuntime(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = connectorId,
                    runtime = runtime,
                    path = path.trim().ifBlank { null },
                )
                DeviceAgentScanResult(
                    attachedRuntimes = scan.attachedRuntimes,
                    runtime = scan.scannedRuntime,
                    report = scan.report,
                )
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not scan agent.", error)
            }
        }
    }

    suspend fun loadDeviceAgentSettings(
        connectorId: String,
        runtime: String,
    ): Result<RuntimeSettingsState> {
        val auth = authSession()
            ?: return Result.failure(IllegalStateException("Sign in again to load agent settings."))

        return withContext(Dispatchers.IO) {
            runCatching {
                val schema = sessionsApi.getRuntimeConfigSchema(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    runtime = runtime,
                )
                devicesApi.getDeviceAgentSettings(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = connectorId,
                    runtime = runtime,
                ).toRuntimeSettingsState(schema)
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not load agent settings.", error)
            }
        }
    }

    suspend fun patchDeviceAgentSettings(
        connectorId: String,
        runtime: String,
        settings: Map<String, Any?>,
    ): Result<RuntimeSettingsState> {
        val auth = authSession()
            ?: return Result.failure(IllegalStateException("Sign in again to save agent settings."))
        if (settings.isEmpty()) {
            return Result.failure(IllegalArgumentException("No supported settings to save."))
        }

        return withContext(Dispatchers.IO) {
            runCatching {
                devicesApi.patchDeviceAgentSettings(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = connectorId,
                    runtime = runtime,
                    settings = settings,
                ).toRuntimeSettingsState(schema = null)
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not save agent settings.", error)
            }
        }
    }

    private fun authSession(): ApiAuth? {
        val serverUrl = sessionStore.readServerUrl()
        val accessToken = sessionStore.readAccessToken()
        return if (serverUrl.isBlank() || accessToken.isBlank()) {
            null
        } else {
            ApiAuth(serverUrl = serverUrl, accessToken = accessToken)
        }
    }

    private data class ApiAuth(
        val serverUrl: String,
        val accessToken: String,
    )

    private fun RemoteRuntimeSettings.toRuntimeSettingsState(
        schema: RemoteRuntimeConfigSchema?,
    ): RuntimeSettingsState {
        return RuntimeSettingsState(
            schema = schema?.toRuntimeConfigSchema(),
            settings = settings,
            overrideSettings = runtimeSettingsOverride,
            isLoading = false,
            savingKey = null,
            errorMessage = null,
        )
    }

    private fun RemoteRuntimeConfigSchema.toRuntimeConfigSchema(): RuntimeConfigSchema {
        return RuntimeConfigSchema(
            runtime = runtime,
            schemaVersion = schemaVersion,
            fields = fields.map { it.toRuntimeConfigField() },
        )
    }

    private fun RemoteRuntimeConfigField.toRuntimeConfigField(): RuntimeConfigField {
        return RuntimeConfigField(
            key = key,
            label = label,
            type = type,
            description = description,
            options = options.map { it.toRuntimeConfigOption() },
            visibleWhen = visibleWhen,
            allowSessionOverride = allowSessionOverride,
            hidden = hidden,
        )
    }

    private fun RemoteRuntimeConfigOption.toRuntimeConfigOption(): RuntimeConfigOption {
        return RuntimeConfigOption(
            value = value,
            label = label,
            description = description,
            efforts = efforts?.map { it.toRuntimeConfigOption() },
        )
    }
}

data class DeviceSetupCredential(
    val device: AgentDevice,
    val serverUrl: String,
    val connectorToken: String,
)

data class DeviceAgentScanResult(
    val attachedRuntimes: List<String>,
    val runtime: String,
    val report: Map<String, Any?>,
)

fun RemoteDevice.toAgentDevice(): AgentDevice {
    val runtimeCount = attachedRuntimes.size
    val subtitle = when {
        runtimeCount > 0 -> attachedRuntimes.joinToString(", ") { it.runtimeLabel() }
        status == "online" -> "Online"
        else -> "Offline"
    }
    return AgentDevice(
        id = id,
        name = name,
        deviceOs = deviceOs,
        subtitle = subtitle,
        online = status == "online",
        attachedRuntimes = attachedRuntimes,
        lastSeenAt = lastSeenAt,
        createdAt = createdAt,
    )
}

private fun String.runtimeLabel(): String {
    return when (this) {
        "codex" -> "Codex"
        "claude" -> "Claude Code"
        "opencode" -> "OpenCode"
        "acp" -> "ACP"
        else -> replaceFirstChar { char ->
            if (char.isLowerCase()) char.titlecase() else char.toString()
        }
    }
}
