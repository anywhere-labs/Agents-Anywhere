package com.agentsanywhere.app.feature.modelconfig

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.RemoteDashboardSnapshot
import com.agentsanywhere.app.feature.devices.DeviceRuntime
import com.agentsanywhere.app.feature.devices.toDeviceRuntime
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.CHANNEL_NATIVE
import com.agentsanywhere.app.model.CHANNEL_TOKENS
import com.agentsanywhere.app.model.ChannelRuntime
import com.agentsanywhere.app.model.ModelAssignment
import com.agentsanywhere.app.model.ModelChannelState
import com.agentsanywhere.app.model.ModelConfigOverview
import com.agentsanywhere.app.model.ModelOffer
import com.agentsanywhere.app.model.ModelProfile
import com.agentsanywhere.app.model.ModelSpec

/** What the dashboard snapshot says about runtimes and model configuration. */
data class ModelConfigState(
    val runtimes: List<DeviceRuntime> = emptyList(),
    val overview: ModelConfigOverview? = null,
    val received: Boolean = false,
)

fun RemoteDashboardSnapshot.toModelConfigState(): ModelConfigState {
    return ModelConfigState(
        runtimes = runtimes.map { it.toDeviceRuntime() },
        overview = modelConfig,
        received = true,
    )
}

enum class RuntimeMaturityBadge { Beta, Experimental }

/** Stable runtimes show no badge; the others say how far along they are. */
fun runtimeMaturityBadge(maturity: String?): RuntimeMaturityBadge? = when (maturity) {
    "beta" -> RuntimeMaturityBadge.Beta
    "experimental" -> RuntimeMaturityBadge.Experimental
    else -> null
}

enum class ModelStatusTone { Ok, Progress, Warning, Error, Neutral }

/** States in which a runtime is still on its way to the channel it should use. */
private val CHANNEL_IN_PROGRESS = setOf("pending", "waiting_online", "switching", "restoring")

fun channelStateTone(state: String): ModelStatusTone = when (state) {
    "applied" -> ModelStatusTone.Ok
    in CHANNEL_IN_PROGRESS -> ModelStatusTone.Progress
    "restored" -> ModelStatusTone.Warning
    "failed" -> ModelStatusTone.Error
    else -> ModelStatusTone.Neutral
}

enum class ChannelKind { Native, Tokens, Manual }

fun channelKind(channel: String): ChannelKind = when (channel) {
    CHANNEL_NATIVE -> ChannelKind.Native
    CHANNEL_TOKENS -> ChannelKind.Tokens
    else -> ChannelKind.Manual
}

/** A channel the user can pick; manual services carry their profile. */
data class ChannelOption(
    val id: String,
    val kind: ChannelKind,
    val profile: ModelProfile? = null,
)

/** The device's own configuration, Anywhere once linked, then every active manual service. */
fun ModelConfigOverview.channelOptions(): List<ChannelOption> = buildList {
    add(ChannelOption(CHANNEL_NATIVE, ChannelKind.Native))
    val tokens = tokens
    if (tokens != null && tokens.available && tokens.linked) {
        add(ChannelOption(CHANNEL_TOKENS, ChannelKind.Tokens, activeTokensProfile()))
    }
    profiles.filter { it.isManual && it.isActive }.forEach { add(ChannelOption(it.id, ChannelKind.Manual, it)) }
}

enum class ChannelPhase { None, Running, Done, Attention }

/** Counts behind one channel's status line, over the runtimes that should use it. */
data class ChannelProgress(
    val phase: ChannelPhase,
    /** Runtimes taking part: every one that can use the channel it should. */
    val total: Int,
    val applied: Int,
    val unfinished: Int,
    /** Devices that are offline with runtimes waiting on them. */
    val offlineDevices: Int,
    val restored: Int,
    val failed: Int,
    val unsupported: Int,
)

fun channelProgress(rows: List<ChannelRuntime>): ChannelProgress {
    val taking = rows.filter { it.state != "unsupported" }
    val restored = taking.count { it.state == "restored" }
    val failed = taking.count { it.state == "failed" }
    val unfinished = taking.count { it.state in CHANNEL_IN_PROGRESS }
    return ChannelProgress(
        phase = when {
            taking.isEmpty() -> ChannelPhase.None
            restored + failed > 0 -> ChannelPhase.Attention
            unfinished > 0 -> ChannelPhase.Running
            else -> ChannelPhase.Done
        },
        total = taking.size,
        applied = taking.count { it.state == "applied" },
        unfinished = unfinished,
        offlineDevices = taking.filter { it.state == "waiting_online" }.map { it.connectorId }.toSet().size,
        restored = restored,
        failed = failed,
        unsupported = rows.size - taking.size,
    )
}

/** Runtimes that should use [channel]: following it as the applied one, or chosen for it. */
fun ModelChannelState?.rowsFor(channel: String): List<ChannelRuntime> =
    this?.runtimes.orEmpty().filter { it.desired == channel }

/** Runtimes actually on [channel] right now. */
fun ModelChannelState.usersOf(channel: String): Int = runtimes.count { it.actual == channel }

/** Runtimes that should use [channel] are still being switched to it. */
fun ModelChannelState.updating(channel: String): Boolean =
    runtimes.any { it.desired == channel && it.state in CHANNEL_IN_PROGRESS }

/** The Server refuses to delete a service that is current, chosen for a runtime or still used. */
fun ModelChannelState?.uses(channel: String): Boolean = this != null &&
    (this.channel == channel || runtimes.any { it.override == channel || it.desired == channel || it.actual == channel })

/** Instances configuration management created; the channel lists the runtime they serve instead. */
const val MODEL_CONFIG_MANAGER = "model-config"

private fun DeviceRuntime.isManagedInstance(assignments: List<ModelAssignment>): Boolean =
    managedBy == MODEL_CONFIG_MANAGER ||
        assignments.any { it.createdRuntime && it.connectorId == connectorId && it.runtimeId == id }

/**
 * The channel row for a runtime. A managed instance is not listed itself:
 * its row is the one of the runtime of the same type it serves on that device.
 */
fun ModelConfigState.channelRowFor(connectorId: String, runtimeId: String): ChannelRuntime? {
    val overview = overview ?: return null
    val channel = overview.channel ?: return null
    channel.runtimes.firstOrNull { it.connectorId == connectorId && it.runtimeId == runtimeId }?.let { return it }
    val runtime = runtimes.firstOrNull { it.connectorId == connectorId && it.id == runtimeId } ?: return null
    if (!runtime.isManagedInstance(overview.assignments)) return null
    return channel.runtimes.firstOrNull { row ->
        row.connectorId == connectorId && runtimes.any {
            it.connectorId == row.connectorId && it.id == row.runtimeId &&
                it.type == runtime.type && !it.isManagedInstance(overview.assignments)
        }
    }
}

/** Changes whenever the channel a runtime actually uses changes, or settles. */
fun runtimeChannelKey(row: ChannelRuntime?): String =
    row?.let { "${it.actual}:${it.appliedGeneration ?: ""}:${it.state == "applied"}" }.orEmpty()

/** A runtime's channel row, with what the runtime itself declares; capability fields decide, never names. */
data class ChannelRuntimeRow(
    val item: ChannelRuntime,
    val runtime: DeviceRuntime?,
    val deviceName: String,
) {
    val key: String get() = item.key
    val name: String get() = runtime?.labels?.primary ?: item.runtimeId
    val maturity: String? get() = runtime?.modelConnection?.maturity ?: runtime?.maturity
    val supported: Boolean get() = item.state != "unsupported"

    /** Takes a model connection, so it can be given its own channel. */
    val canOverride: Boolean get() = runtime?.modelConnection != null

    /** Writing an AA channel changes the runtime's own global settings. */
    val nativeGlobal: Boolean get() = runtime?.modelConnection?.scope == "native_global"
    val canRetry: Boolean get() = item.state == "restored" || item.state == "failed"

    /** Giving a global-scope runtime an AA channel needs the user's explicit confirmation. */
    fun needsNativeGlobalConfirmation(channel: String?): Boolean =
        nativeGlobal && channel != null && channel != CHANNEL_NATIVE
}

data class ChannelDeviceGroup(
    val connectorId: String,
    val deviceName: String,
    val rows: List<ChannelRuntimeRow>,
)

/** Rows by device in the device list's order; unsupported runtimes on their own, last. */
data class ChannelGroups(
    val devices: List<ChannelDeviceGroup>,
    val unsupported: List<ChannelRuntimeRow>,
)

fun channelGroups(
    state: ModelChannelState,
    runtimes: List<DeviceRuntime>,
    devices: List<AgentDevice>,
): ChannelGroups {
    val byKey = runtimes.associateBy { "${it.connectorId}/${it.id}" }
    val deviceOrder = devices.withIndex().associate { (index, device) -> device.id to index }
    val rows = state.runtimes.map { item ->
        ChannelRuntimeRow(
            item = item,
            runtime = byKey[item.key],
            deviceName = devices.firstOrNull { it.id == item.connectorId }?.name ?: item.connectorId,
        )
    }
    val (supported, unsupported) = rows.partition { it.supported }
    val groups = supported
        .groupBy { it.item.connectorId }
        .map { (connectorId, items) -> ChannelDeviceGroup(connectorId, items.first().deviceName, items) }
        .withIndex()
        .sortedWith(compareBy({ deviceOrder[it.value.connectorId] ?: Int.MAX_VALUE }, { it.index }))
        .map { it.value }
    val unsupportedSorted = unsupported.withIndex()
        .sortedWith(compareBy({ deviceOrder[it.value.item.connectorId] ?: Int.MAX_VALUE }, { it.index }))
        .map { it.value }
    return ChannelGroups(groups, unsupportedSorted)
}

fun ModelConfigOverview.activeTokensProfile(): ModelProfile? =
    profiles.firstOrNull { it.isTokens && it.isActive }

fun ModelConfigOverview.usedBy(profileId: String): Int =
    assignments.count { it.profileId == profileId }

fun ModelProfile.modelCount(): Int = offers.flatMap { offer -> offer.models.map { it.id } }.toSet().size

/** Only manual or detached services, and only when no runtime uses or wants them. */
fun ModelProfile.canDelete(usedBy: Int, inChannel: Boolean = false): Boolean =
    (isManual || !isActive) && usedBy == 0 && !inChannel

/** Model IDs parsed from a free-form list: one per line or separated by commas. */
fun parseModelIds(text: String): List<String> =
    text.split('\n', ',').map(String::trim).filter(String::isNotEmpty).distinct()

val MODEL_PROTOCOLS = listOf("openai_responses", "openai_chat", "anthropic")

data class OfferDraft(
    val enabled: Boolean = false,
    val baseUrl: String = "",
    val models: String = "",
)

/**
 * The add-profile form. The key is sent once and never read back.
 *
 * In automatic mode the user gives only the address and the Server detects the
 * protocols and models; [manual] mode lists them per protocol, as before.
 */
data class ManualProfileDraft(
    val name: String = "",
    val apiKey: String = "",
    val baseUrl: String = "",
    val manual: Boolean = false,
    val offers: Map<String, OfferDraft> = MODEL_PROTOCOLS.associateWith { OfferDraft(enabled = it == "openai_chat") },
) {
    val chosenProtocols: List<String>
        get() = MODEL_PROTOCOLS.filter { offers[it]?.enabled == true }

    val valid: Boolean
        get() = name.isNotBlank() && apiKey.isNotBlank() && if (manual) {
            chosenProtocols.isNotEmpty() && chosenProtocols.all { HTTP_URL.matches(offers[it]?.baseUrl?.trim().orEmpty()) }
        } else {
            HTTP_URL.matches(baseUrl.trim())
        }

    fun withOffer(protocol: String, transform: (OfferDraft) -> OfferDraft): ManualProfileDraft =
        copy(offers = offers + (protocol to transform(offers[protocol] ?: OfferDraft())))

    /** Switches to manual mode, filling each protocol's empty address from the one entered. */
    fun toManual(): ManualProfileDraft = copy(
        manual = true,
        offers = offers.mapValues { (protocol, offer) ->
            if (offer.baseUrl.isBlank()) offer.copy(baseUrl = protocolBaseUrl(protocol, baseUrl)) else offer
        },
    )

    fun toOffers(): List<ModelOffer> = chosenProtocols.map { protocol ->
        val draft = offers.getValue(protocol)
        ModelOffer(
            format = protocol,
            baseUrl = draft.baseUrl.trim(),
            models = parseModelIds(draft.models).map { ModelSpec(id = it) },
        )
    }

    private companion object {
        val HTTP_URL = Regex("^https?://\\S+$")
    }
}

/**
 * A protocol's address guessed from the one the user entered: OpenAI protocols use it as is,
 * Anthropic's clients add `/v1` themselves, so a trailing `/v1` is dropped.
 */
fun protocolBaseUrl(protocol: String, address: String): String {
    val base = address.trim().trimEnd('/')
    return if (protocol == "anthropic") base.removeSuffix("/v1").trimEnd('/') else base
}

/** Detection failed for a reason the user can work around by entering the protocols and models. */
val GATEWAY_MANUAL_FALLBACK_CODES = setOf("gateway_address_not_allowed", "gateway_unreachable", "gateway_protocols_unknown")

/** Detection errors shown inside the add-profile form instead of as a toast. */
val GATEWAY_ERROR_CODES = GATEWAY_MANUAL_FALLBACK_CODES + "gateway_key_rejected"

/** The Server's stable error code, used to pick localized text. */
fun modelConfigErrorCode(error: Throwable): String? = (error as? ApiException)?.errorCode
