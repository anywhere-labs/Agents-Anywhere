package dev.agentsanywhere.v3.core.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// Control plane HTTP (server-v3/aa_control/core/models.py) and aa.v3.Control (contracts/aa-v3/1.0/control.schema.json).

@Serializable
data class UserView(
    val id: String,
    val email: String? = null,
    val display_name: String = "",
    val role: String = "user",
    val created_at: String = "",
    val plan: String? = null,
)

@Serializable
data class AuthConfig(
    val auth_mode: String = "local",
    val needs_bootstrap: Boolean = false,
    val registration_open: Boolean = false,
    val oauth_enabled: Boolean = false,
    val oauth_provider_label: String? = null,
    val server_time: String? = null,
)

@Serializable
data class LoginRequest(val email: String, val password: String, val client_id: String, val client_platform: String = "android")

@Serializable
data class RefreshRequest(val refresh_token: String)

@Serializable
data class AuthTokenResponse(
    val user: UserView,
    val access_token: String,
    val refresh_token: String,
    val expires_in: Long,
    val client_id: String,
)

@Serializable
data class RouterTokenRequest(val client_id: String, val platform: String = "android")

@Serializable
data class RouterTokenEntry(
    val router_id: String,
    val router_url: String,
    val token: String,
    val token_id: String,
    val expires_at: String,
)

@Serializable
data class RouterTokenResponse(val principal: String, val tokens: List<RouterTokenEntry>)

/** `{"code": …, "detail": …}`: every control plane HTTP error. */
@Serializable
data class ApiErrorBody(val code: String? = null, val detail: JsonElement? = null)

@Serializable
data class DeviceSummaryHint(
    val runtimes: List<String> = emptyList(),
    val active_sessions: Long = 0,
    val pending_approvals: Long = 0,
)

@Serializable
data class DeviceRecord(
    val id: String,
    val name: String,
    val platform: String = "macos",
    val connector_version: String = "",
    /** "normal" | "encrypted" */
    val mode_hint: String = "normal",
    /** "online" | "offline" */
    val presence: String = "offline",
    val created_at: String = "",
    val last_seen_at: String = "",
    val summary: DeviceSummaryHint? = null,
    /** Not authoritative: an encrypted device's key is only ever trusted from its pairing QR code. */
    val e2e_public_key_hint: String? = null,
) {
    val online: Boolean get() = presence == "online"
    val encrypted: Boolean get() = mode_hint == "encrypted"
}

@Serializable
data class DeviceList(val devices: List<DeviceRecord> = emptyList())

/** `watch_devices` items: snapshot, then whole-record upserts and removals. */
sealed interface DevicesEvent {
    data class Snapshot(val devices: List<DeviceRecord>) : DevicesEvent
    data class Upsert(val device: DeviceRecord) : DevicesEvent
    data class Remove(val deviceId: String) : DevicesEvent
}

@Serializable
internal data class RawDevicesEvent(
    val type: String,
    val devices: List<DeviceRecord>? = null,
    val device: DeviceRecord? = null,
    val device_id: String? = null,
)

@Serializable
data class OpenTunnelRequest(val device_id: String, val client_id: String? = null, val e2e_key: String? = null)

@Serializable
data class OpenTunnelResponse(
    val router_url: String,
    val credential: String,
    val tunnel_id: String,
    val expires_at: String,
    /** "normal" | "encrypted" */
    val mode: String = "normal",
)

@Serializable
data class ListSessionsRequest(val device_ids: List<String>? = null, val limit_per_device: Int? = null)

@Serializable
data class DeviceError(val code: String, val message: String = "")

/** One device's slice of `aa.v3.Control/list_sessions` (or a local tunnel `aa.v3.Sessions/list`). */
@Serializable
data class DeviceSessionResult(
    val device_id: String,
    /** "ok" | "offline" | "timeout" | "error" | "encrypted" */
    val status: String,
    val value: SessionList? = null,
    val error: DeviceError? = null,
)

@Serializable
data class SessionSummary(
    val id: String,
    val title: String = "",
    val agent: String = "",
    val device_id: String,
    val cwd: String = "",
    /** "idle" | "running" | "error" | "disconnected" | "waiting" */
    val state: String = "idle",
    val unread: Boolean = false,
    val pinned: Boolean = false,
    val updated_at: String = "",
)

@Serializable
data class SessionList(val sessions: List<SessionSummary> = emptyList(), val projects: List<String> = emptyList())

/** `aa.v3.Sessions/watch_list` items: the whole list every time. */
@Serializable
data class SessionListEvent(
    val type: String = "snapshot",
    val sessions: List<SessionSummary> = emptyList(),
    val projects: List<String> = emptyList(),
)

@Serializable
data class Empty(val ok: Boolean? = null)

@Serializable
data class IdRequest(val id: String)

/** Untyped passthrough (requests built with jsonOf). */
typealias RawRequest = JsonObject
