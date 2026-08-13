package com.agentsanywhere.app.feature.devices

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.DevicesApi
import com.agentsanywhere.app.api.RemoteDevice
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import com.agentsanywhere.app.model.AgentDevice
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class DevicesController(
    private val devicesApi: DevicesApi,
    private val sessionStore: AuthSessionStore,
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

    suspend fun listDeviceRuntimes(
        connectorId: String,
    ): Result<DeviceRuntimeList> {
        val auth = authSession()
            ?: return Result.failure(IllegalStateException("Sign in again to load runtimes."))

        return withContext(Dispatchers.IO) {
            runCatching {
                devicesApi.listDeviceRuntimes(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = connectorId,
                ).toDeviceRuntimeList()
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not load runtimes.", error)
            }
        }
    }

    suspend fun discoverDeviceRuntimes(
        connectorId: String,
    ): Result<DeviceRuntimeList> {
        val auth = authSession()
            ?: return Result.failure(IllegalStateException("Sign in again to discover runtimes."))

        return withContext(Dispatchers.IO) {
            runCatching {
                devicesApi.discoverDeviceRuntimes(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = connectorId,
                ).toDeviceRuntimeList()
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not discover runtimes.", error)
            }
        }
    }

    suspend fun saveDeviceRuntimeConfig(
        connectorId: String,
        runtime: String,
        config: Map<String, Any?>,
    ): Result<DeviceRuntime> {
        val auth = authSession()
            ?: return Result.failure(IllegalStateException("Sign in again to save runtime configuration."))

        return withContext(Dispatchers.IO) {
            runCatching {
                devicesApi.putDeviceRuntimeConfig(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = connectorId,
                    runtime = runtime,
                    config = config,
                ).toDeviceRuntime()
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not save runtime configuration.", error)
            }
        }
    }

    suspend fun setDeviceRuntimeActive(
        connectorId: String,
        runtime: String,
        active: Boolean,
    ): Result<DeviceRuntime> {
        val auth = authSession()
            ?: return Result.failure(IllegalStateException("Sign in again to update this runtime."))

        return withContext(Dispatchers.IO) {
            runCatching {
                devicesApi.setDeviceRuntimeActive(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = connectorId,
                    runtime = runtime,
                    active = active,
                ).toDeviceRuntime()
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not update runtime state.", error)
            }
        }
    }

    suspend fun deleteDeviceRuntimeConfig(
        connectorId: String,
        runtime: String,
    ): Result<DeviceRuntime> {
        val auth = authSession()
            ?: return Result.failure(IllegalStateException("Sign in again to delete runtime configuration."))

        return withContext(Dispatchers.IO) {
            runCatching {
                devicesApi.deleteDeviceRuntimeConfig(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = connectorId,
                    runtime = runtime,
                ).toDeviceRuntime()
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not delete runtime configuration.", error)
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

}

data class DeviceSetupCredential(
    val device: AgentDevice,
    val serverUrl: String,
    val connectorToken: String,
)

fun RemoteDevice.toAgentDevice(): AgentDevice {
    return AgentDevice(
        id = id,
        name = name,
        deviceOs = deviceOs,
        subtitle = if (status == "online") "Online" else "Offline",
        online = status == "online",
        lastSeenAt = lastSeenAt,
        createdAt = createdAt,
    )
}
