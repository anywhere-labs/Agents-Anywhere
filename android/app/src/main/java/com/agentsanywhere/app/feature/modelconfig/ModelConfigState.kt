package com.agentsanywhere.app.feature.modelconfig

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.RemoteDashboardSnapshot
import com.agentsanywhere.app.api.RemoteModelOperation
import com.agentsanywhere.app.api.RemoteModelPreviewTarget
import com.agentsanywhere.app.feature.devices.DeviceRuntime
import com.agentsanywhere.app.feature.devices.toDeviceRuntime
import com.agentsanywhere.app.model.ModelAssignment
import com.agentsanywhere.app.model.ModelConfigOverview
import com.agentsanywhere.app.model.ModelConnectionStatus
import com.agentsanywhere.app.model.ModelOffer
import com.agentsanywhere.app.model.ModelProfile
import com.agentsanywhere.app.model.ModelSpec
import java.util.UUID

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

fun connectionStateTone(state: String?): ModelStatusTone = when (state) {
    "applied" -> ModelStatusTone.Ok
    "saved_pending" -> ModelStatusTone.Progress
    "failed" -> ModelStatusTone.Error
    "managed_externally" -> ModelStatusTone.Warning
    else -> ModelStatusTone.Neutral
}

fun assignmentStatusTone(status: String): ModelStatusTone = when (status) {
    "applied" -> ModelStatusTone.Ok
    "applying" -> ModelStatusTone.Progress
    "failed" -> ModelStatusTone.Error
    else -> ModelStatusTone.Warning
}

const val MODEL_CONFIG_MANAGED = "model-config"

/** A runtime that takes a model connection, with its assignment if it has one. */
data class ModelConfigDeviceRow(
    val runtime: DeviceRuntime,
    val assignment: ModelAssignment?,
) {
    val key: String get() = "${runtime.connectorId}/${runtime.id}"
    val status: ModelConnectionStatus? get() = assignment?.modelConnectionStatus ?: runtime.modelConnectionStatus
    val maturity: String? get() = runtime.modelConnection?.maturity ?: runtime.maturity
    val managedHere: Boolean get() = runtime.managedBy == MODEL_CONFIG_MANAGED
}

/** Rows for every instance that declares a model connection; capability fields decide, never names. */
fun modelConfigDeviceRows(
    runtimes: List<DeviceRuntime>,
    assignments: List<ModelAssignment>,
): List<ModelConfigDeviceRow> {
    val byTarget = assignments.associateBy { "${it.connectorId}/${it.runtimeId}" }
    return runtimes
        .filter { it.modelConnection != null }
        .map { ModelConfigDeviceRow(it, byTarget["${it.connectorId}/${it.id}"]) }
}

fun ModelConfigOverview.activeTokensProfile(): ModelProfile? =
    profiles.firstOrNull { it.isTokens && it.isActive }

fun ModelConfigOverview.usedBy(profileId: String): Int =
    assignments.count { it.profileId == profileId }

fun ModelProfile.modelCount(): Int = offers.flatMap { offer -> offer.models.map { it.id } }.toSet().size

fun ModelProfile.canDelete(usedBy: Int): Boolean = (isManual || !isActive) && usedBy == 0

fun newIdempotencyKey(): String = UUID.randomUUID().toString()

/** Model IDs parsed from a free-form list: one per line or separated by commas. */
fun parseModelIds(text: String): List<String> =
    text.split('\n', ',').map(String::trim).filter(String::isNotEmpty).distinct()

val MODEL_PROTOCOLS = listOf("openai_responses", "openai_chat", "anthropic")

data class OfferDraft(
    val enabled: Boolean = false,
    val baseUrl: String = "",
    val models: String = "",
)

/** The add-profile form. The key is sent once and never read back. */
data class ManualProfileDraft(
    val name: String = "",
    val apiKey: String = "",
    val offers: Map<String, OfferDraft> = MODEL_PROTOCOLS.associateWith { OfferDraft(enabled = it == "openai_chat") },
) {
    val chosenProtocols: List<String>
        get() = MODEL_PROTOCOLS.filter { offers[it]?.enabled == true }

    val valid: Boolean
        get() = name.isNotBlank() && apiKey.isNotBlank() && chosenProtocols.isNotEmpty() &&
            chosenProtocols.all { HTTP_URL.matches(offers[it]?.baseUrl?.trim().orEmpty()) }

    fun withOffer(protocol: String, transform: (OfferDraft) -> OfferDraft): ManualProfileDraft =
        copy(offers = offers + (protocol to transform(offers[protocol] ?: OfferDraft())))

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

/** Apply dialog choices derived from the preview. */
data class ApplySelection(
    val targets: List<RemoteModelPreviewTarget>,
    val selected: Set<String>,
) {
    val chosen: List<RemoteModelPreviewTarget>
        get() = targets.filter { it.key in selected }

    /** Changing a runtime's own global settings needs an explicit confirmation. */
    val needsNativeGlobalConfirmation: Boolean
        get() = chosen.any { it.requiresConfirmation }

    /** Tasks a restart would interrupt. */
    val runningSessions: Int
        get() = chosen.sumOf { if (it.effect == "restart") it.runningSessions else 0 }

    fun selectable(target: RemoteModelPreviewTarget): Boolean = target.canApply && !target.tooManyModels

    fun toggle(target: RemoteModelPreviewTarget, checked: Boolean): ApplySelection {
        if (!selectable(target)) return this
        return copy(selected = if (checked) selected + target.key else selected - target.key)
    }

    fun canSubmit(confirmedNativeGlobal: Boolean): Boolean =
        chosen.isNotEmpty() && (!needsNativeGlobalConfirmation || confirmedNativeGlobal)

    companion object {
        /** Never preselects targets that change global settings or import too many models. */
        fun initial(targets: List<RemoteModelPreviewTarget>): ApplySelection = ApplySelection(
            targets = targets,
            selected = targets
                .filter { it.canApply && !it.requiresConfirmation && !it.tooManyModels }
                .mapTo(mutableSetOf()) { it.key },
        )
    }
}

data class OperationSummary(val applied: Int, val other: Int)

fun RemoteModelOperation.summary(): OperationSummary {
    val applied = results.count { it.result == "applied" }
    return OperationSummary(applied = applied, other = results.size - applied)
}

/** The Server's stable error code, used to pick localized text. */
fun modelConfigErrorCode(error: Throwable): String? = (error as? ApiException)?.errorCode
