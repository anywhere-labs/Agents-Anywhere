package com.agentsanywhere.app.model

/**
 * Model connections: a gateway address, a write-only key and models, written to
 * runtimes that declare a [ModelConnectionCapability]. Wire values stay strings so
 * a newer Server can add values without breaking older clients.
 */
data class ModelConnectionCapability(
    val maturity: String?,
    val configField: String,
    val modelsField: String?,
    val protocols: List<String>,
    val modes: List<ModelConnectionMode>,
    val modeField: String?,
    val scope: String,
    val catalogAuto: Boolean,
    val catalogManual: Boolean,
    val apply: String,
)

data class ModelConnectionMode(
    val id: String,
    val supported: Boolean,
    val reason: String?,
)

data class ModelConnectionStatus(
    val state: String,
    val protocol: String?,
    val scope: String?,
    val mode: String?,
    val reason: String?,
    val externalOwner: String?,
)

/** A write-only config value: whether one is saved and a short hint to recognize it. */
data class SecretFieldState(
    val set: Boolean,
    val hint: String?,
)

data class ModelSpec(
    val id: String,
    val name: String? = null,
    val efforts: List<String> = emptyList(),
    val input: List<String> = emptyList(),
    /** Who makes the model, as Tokens Anywhere reports it. */
    val vendor: String? = null,
    val contextWindow: Long? = null,
    val maxOutputTokens: Long? = null,
)

/** Models turned off, and names shown in place of the model's own; Agents Anywhere only. */
data class ModelPreferences(
    val disabled: List<String> = emptyList(),
    val names: Map<String, String> = emptyMap(),
) {
    companion object {
        val EMPTY = ModelPreferences()
    }
}

data class ModelOffer(
    val format: String,
    val baseUrl: String,
    val models: List<ModelSpec>,
)

data class ModelProfile(
    val id: String,
    val source: String,
    val name: String,
    val originHost: String,
    val offers: List<ModelOffer>,
    val keyHint: String?,
    val strategyName: String?,
    val state: String,
    val etag: String,
    val updatedAt: String?,
    val preferences: ModelPreferences = ModelPreferences.EMPTY,
) {
    val isActive: Boolean get() = state == "active"
    val isTokens: Boolean get() = source == "tokens"
    val isManual: Boolean get() = source == "manual"
}

/** A runtime that really uses an AA channel; switch progress lives in [ModelChannelState]. */
data class ModelAssignment(
    val connectorId: String,
    val runtimeId: String,
    val profileId: String,
    val offerFormat: String?,
    val createdRuntime: Boolean,
    /** "applied", "modified" (changed by hand since) or "outdated" (waiting to be written again). */
    val status: String,
    val errorCode: String?,
    val errorMessage: String?,
    val appliedAt: String?,
    val modelConnectionStatus: ModelConnectionStatus?,
)

data class TokensLink(
    val status: String,
    val issuer: String?,
    val accountId: String,
    val accountDisplayName: String?,
    val accountEmail: String?,
    val linkedAt: String?,
    val relinkSoon: Boolean,
) {
    val linked: Boolean get() = status == "linked"
    val accountLabel: String get() = accountDisplayName ?: accountEmail ?: accountId
}

data class TokensLinkStatus(
    val available: Boolean,
    val tokensUrl: String?,
    val secretConfigured: Boolean,
    val link: TokensLink?,
) {
    val linked: Boolean get() = link?.linked == true
}

/** The channel every runtime follows unless it has its own: AA writes no model connection. */
const val CHANNEL_NATIVE = "native"

/** The linked Tokens Anywhere account; manual services use their profile ID as the channel. */
const val CHANNEL_TOKENS = "tokens"

/** The latest change of the current channel or an override, and how far it got. */
data class ChannelSwitch(
    val revision: Long,
    /** "running", "done" or "attention". */
    val state: String,
    val startedAt: String?,
    val finishedAt: String?,
)

/** One runtime's channel: what it should use, what it really uses, and the switch between them. */
data class ChannelRuntime(
    val connectorId: String,
    val runtimeId: String,
    /** Its own channel; null follows the current channel. */
    val override: String?,
    val desired: String?,
    val actual: String?,
    /** "applied", "pending", "waiting_online", "switching", "restoring", "restored", "failed" or "unsupported". */
    val state: String,
    /** While switching: "preparing", "activating" or "verifying". */
    val step: String?,
    val reason: String?,
    val message: String?,
    val updatedAt: String?,
    val desiredGeneration: Long? = null,
    val appliedGeneration: Long? = null,
    val observedAt: String? = null,
    val retryAt: String? = null,
) {
    val key: String get() = "$connectorId/$runtimeId"
}

/** The current channel and every runtime's progress towards it. */
data class ModelChannelState(
    val channel: String,
    val revision: Long,
    /** Null until the channel was changed for the first time. */
    val switch: ChannelSwitch?,
    val runtimes: List<ChannelRuntime>,
)

data class ModelConfigOverview(
    val secretConfigured: Boolean,
    val profiles: List<ModelProfile>,
    val assignments: List<ModelAssignment>,
    val tokens: TokensLinkStatus?,
    /** Missing from older Servers. */
    val channel: ModelChannelState? = null,
)
