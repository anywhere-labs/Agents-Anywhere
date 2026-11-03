package com.agentsanywhere.app.model

/**
 * Model connections: a gateway address, a write-only key and models, applied to
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

data class ModelAssignment(
    val connectorId: String,
    val runtimeId: String,
    val profileId: String,
    val offerFormat: String?,
    val createdRuntime: Boolean,
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
    /** The last one-click setup: what was ticked and how far it got. */
    val quickSetup: QuickSetupProgress? = null,
) {
    val linked: Boolean get() = link?.linked == true
}

data class ModelTarget(
    val connectorId: String,
    val runtimeId: String,
) {
    val key: String get() = "$connectorId/$runtimeId"
}

data class QuickSetupRequest(
    val targets: List<ModelTarget>,
    val confirmNativeGlobal: Boolean,
)

data class QuickSetupResult(
    val connectorId: String,
    val runtimeId: String,
    /** "applied", "deferred", "skipped" or "failed". */
    val result: String,
    val reason: String?,
    val modelsTrimmed: Int,
    val servesRuntimeId: String?,
) {
    val key: String get() = "$connectorId/$runtimeId"
}

data class QuickSetupProgress(
    /** "syncing", "applying", "done" or "failed". */
    val state: String,
    val request: QuickSetupRequest,
    val startedAt: String?,
    /** Where a failure happened: "sync" or "apply". */
    val step: String?,
    val code: String?,
    val results: List<QuickSetupResult>,
)

data class ModelConfigOverview(
    val secretConfigured: Boolean,
    val profiles: List<ModelProfile>,
    val assignments: List<ModelAssignment>,
    val tokens: TokensLinkStatus?,
)
