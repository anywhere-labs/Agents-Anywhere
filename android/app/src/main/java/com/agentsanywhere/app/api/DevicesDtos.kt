package com.agentsanywhere.app.api

data class RemoteDevice(
    val id: String,
    val name: String,
    val deviceOs: String?,
    val status: String,
    val lastSeenAt: String?,
    val attachedRuntimes: List<String>,
    val createdAt: String?,
    val updatedAt: String?,
)

data class RemoteDeviceCredential(
    val device: RemoteDevice,
    val deviceToken: String,
    val tokenPrefix: String?,
)

data class RemoteDeviceRuntimeScan(
    val attachedRuntimes: List<String>,
    val scannedRuntime: String,
    val report: Map<String, Any?>,
)
