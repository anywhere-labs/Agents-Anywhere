package com.agentsanywhere.app.api

import com.agentsanywhere.app.model.ModelAssignment
import com.agentsanywhere.app.model.ModelConfigOverview
import com.agentsanywhere.app.model.ModelConnectionCapability
import com.agentsanywhere.app.model.ModelConnectionMode
import com.agentsanywhere.app.model.ModelConnectionStatus
import com.agentsanywhere.app.model.ModelOffer
import com.agentsanywhere.app.model.ModelPreferences
import com.agentsanywhere.app.model.ModelProfile
import com.agentsanywhere.app.model.ModelSpec
import com.agentsanywhere.app.model.ModelTarget
import com.agentsanywhere.app.model.QuickSetupProgress
import com.agentsanywhere.app.model.QuickSetupRequest
import com.agentsanywhere.app.model.QuickSetupResult
import com.agentsanywhere.app.model.SecretFieldState
import com.agentsanywhere.app.model.TokensLink
import com.agentsanywhere.app.model.TokensLinkStatus
import org.json.JSONArray
import org.json.JSONObject

data class RemoteModelTarget(
    val connectorId: String,
    val runtimeId: String,
)

data class RemoteModelPreviewTarget(
    val connectorId: String,
    val runtimeId: String,
    val runtimeType: String,
    val name: String?,
    val maturity: String?,
    val decision: String,
    val reason: String?,
    val offerFormat: String?,
    val effect: String?,
    val scope: String?,
    val requiresConfirmation: Boolean,
    val runningSessions: Int,
    val replacesHost: String?,
    val modelLimit: Int?,
    val tooManyModels: Boolean,
    val capabilityMaturity: String?,
) {
    val key: String get() = "$connectorId/$runtimeId"
    val canApply: Boolean get() = decision == "apply"
}

data class RemoteModelOperationResult(
    val connectorId: String,
    val runtimeId: String,
    val result: String,
    val reason: String?,
)

data class RemoteModelOperation(
    val operationId: String?,
    val kind: String,
    val finished: Boolean,
    val results: List<RemoteModelOperationResult>,
)

data class RemoteQuickSetupStart(
    val started: Boolean,
    /** Set when the browser must authorize the link first. */
    val startUrl: String?,
)

data class RemoteTokensUnlinkResult(
    val revoked: Boolean,
    val results: List<RemoteModelOperationResult>,
)

/** Amounts are decimal yuan strings with four places, as Tokens Anywhere sends them. */
data class RemoteTokensBalance(
    val balance: String?,
    val available: String?,
    val held: String?,
    val bonus: String?,
)

data class RemoteTokensAccount(
    val id: String,
    val displayName: String?,
    val email: String?,
    val balance: RemoteTokensBalance,
    val consoleUrl: String?,
    val billingUrl: String?,
    val usageUrl: String?,
) {
    val label: String get() = displayName ?: email ?: id
}

data class RemoteTokensUsageItem(
    /** A Beijing date, `yyyy-MM-dd`. */
    val date: String,
    val model: String?,
    val requests: Long,
    val inputTokens: Long,
    val outputTokens: Long,
    val cacheReadTokens: Long,
    val cacheWrite5mTokens: Long,
    val cacheWrite1hTokens: Long,
    val amountCharged: String,
)

/** The whole Tokens account's settled usage; quiet days are absent. */
data class RemoteTokensUsage(
    val from: String,
    val to: String,
    val items: List<RemoteTokensUsageItem>,
)

internal fun JSONObject.toModelConfigOverview(): ModelConfigOverview {
    return ModelConfigOverview(
        secretConfigured = optBoolean("secretConfigured", false),
        profiles = optJSONArray("profiles").toObjectList { toModelProfile() }.filter { it.id.isNotBlank() },
        assignments = optJSONArray("assignments").toObjectList { toModelAssignment() }
            .filter { it.connectorId.isNotBlank() && it.runtimeId.isNotBlank() },
        tokens = optJSONObject("tokens")?.toTokensLinkStatus(),
    )
}

internal fun JSONObject.toModelProfile(): ModelProfile {
    return ModelProfile(
        id = optString("id"),
        source = optString("source", "manual").ifBlank { "manual" },
        name = optString("name").ifBlank { optString("id") },
        originHost = optString("originHost"),
        offers = optJSONArray("offers").toObjectList { toModelOffer() },
        keyHint = optNullableString("keyHint"),
        strategyName = optNullableString("strategyName"),
        state = optString("state", "active").ifBlank { "active" },
        etag = if (has("etag") && !isNull("etag")) opt("etag").toString() else "",
        updatedAt = optNullableString("updatedAt"),
        preferences = optJSONObject("preferences")?.toModelPreferences() ?: ModelPreferences.EMPTY,
    )
}

internal fun JSONObject.toModelPreferences(): ModelPreferences {
    val names = optJSONObject("names")
    return ModelPreferences(
        disabled = optJSONArray("disabled").toStringList().distinct(),
        names = names?.keys()?.asSequence()
            ?.mapNotNull { id -> names.optNullableString(id)?.let { id to it } }
            ?.toMap()
            .orEmpty(),
    )
}

internal fun ModelPreferences.toJson(): JSONObject = JSONObject()
    .put("disabled", JSONArray().apply { disabled.forEach { put(it) } })
    .put("names", JSONObject().apply { names.forEach { (id, name) -> put(id, name) } })

internal fun JSONObject.toTokensAccount(): RemoteTokensAccount {
    val account = optJSONObject("account")
    val balance = optJSONObject("balance")
    val links = optJSONObject("links")
    return RemoteTokensAccount(
        id = account?.optString("id").orEmpty(),
        displayName = account?.optNullableString("displayName"),
        email = account?.optNullableString("email"),
        balance = RemoteTokensBalance(
            balance = balance?.optNullableString("balance"),
            available = balance?.optNullableString("available"),
            held = balance?.optNullableString("held"),
            bonus = balance?.optNullableString("bonus"),
        ),
        consoleUrl = links?.optNullableString("console"),
        billingUrl = links?.optNullableString("billing"),
        usageUrl = links?.optNullableString("usage"),
    )
}

internal fun JSONObject.toTokensUsage(): RemoteTokensUsage {
    return RemoteTokensUsage(
        from = optString("from"),
        to = optString("to"),
        items = optJSONArray("items").toObjectList {
            RemoteTokensUsageItem(
                date = optString("date"),
                model = optNullableString("model"),
                requests = optLong("requests", 0),
                inputTokens = optLong("inputTokens", 0),
                outputTokens = optLong("outputTokens", 0),
                cacheReadTokens = optLong("cacheReadTokens", 0),
                cacheWrite5mTokens = optLong("cacheWrite5mTokens", 0),
                cacheWrite1hTokens = optLong("cacheWrite1hTokens", 0),
                amountCharged = optString("amountCharged", "0"),
            )
        }.filter { it.date.isNotBlank() },
    )
}

private fun JSONObject.toModelOffer(): ModelOffer {
    return ModelOffer(
        format = optString("format"),
        baseUrl = optString("baseUrl"),
        models = optJSONArray("models").toObjectList {
            ModelSpec(
                id = optString("id"),
                name = optNullableString("name"),
                efforts = optJSONArray("efforts").toStringList(),
                input = optJSONArray("input").toStringList(),
                vendor = optNullableString("vendor"),
                contextWindow = optNullableLong("contextWindow"),
                maxOutputTokens = optNullableLong("maxOutputTokens"),
            )
        }.filter { it.id.isNotBlank() },
    )
}

private fun JSONObject.toModelAssignment(): ModelAssignment {
    val error = optJSONObject("error")
    return ModelAssignment(
        connectorId = optString("connectorId"),
        runtimeId = optString("runtimeId"),
        profileId = optString("profileId"),
        offerFormat = optNullableString("offerFormat"),
        createdRuntime = optBoolean("createdRuntime", false),
        status = optString("status", "applied").ifBlank { "applied" },
        errorCode = error?.optNullableString("code"),
        errorMessage = error?.optNullableString("message"),
        appliedAt = optNullableString("appliedAt"),
        modelConnectionStatus = optJSONObject("modelConnectionStatus")?.toModelConnectionStatus(),
    )
}

private fun JSONObject.toTokensLinkStatus(): TokensLinkStatus {
    val link = optJSONObject("link")
    return TokensLinkStatus(
        available = optBoolean("available", false),
        tokensUrl = optNullableString("tokensUrl"),
        secretConfigured = optBoolean("secretConfigured", false),
        link = link?.let { value ->
            val account = value.optJSONObject("account")
            TokensLink(
                status = value.optString("status", "linked").ifBlank { "linked" },
                issuer = value.optNullableString("issuer"),
                accountId = account?.optString("id").orEmpty(),
                accountDisplayName = account?.optNullableString("displayName"),
                accountEmail = account?.optNullableString("email"),
                linkedAt = value.optNullableString("linkedAt"),
                relinkSoon = value.optBoolean("relinkSoon", false),
            )
        },
        quickSetup = optJSONObject("quickSetup")?.toQuickSetupProgress(),
    )
}

internal fun JSONObject.toQuickSetupProgress(): QuickSetupProgress? {
    val state = optNullableString("state") ?: return null
    val request = optJSONObject("request")
    return QuickSetupProgress(
        state = state,
        request = QuickSetupRequest(
            targets = request?.optJSONArray("targets").toObjectList {
                ModelTarget(optString("connectorId"), optString("runtimeId"))
            }.filter { it.connectorId.isNotBlank() && it.runtimeId.isNotBlank() },
            confirmNativeGlobal = request?.optBoolean("confirmNativeGlobal", false) ?: false,
        ),
        startedAt = optNullableString("startedAt"),
        step = optNullableString("step"),
        code = optNullableString("code"),
        results = optJSONArray("results").toObjectList {
            QuickSetupResult(
                connectorId = optString("connectorId"),
                runtimeId = optString("runtimeId"),
                result = optString("result"),
                reason = optNullableString("reason"),
                modelsTrimmed = optInt("modelsTrimmed", 0),
                servesRuntimeId = optNullableString("servesRuntimeId"),
            )
        },
    )
}

internal fun JSONObject.toModelConnectionCapability(): ModelConnectionCapability? {
    val configField = optNullableString("configField") ?: return null
    val catalog = optJSONObject("catalog")
    return ModelConnectionCapability(
        maturity = optNullableString("maturity"),
        configField = configField,
        modelsField = optNullableString("modelsField"),
        protocols = optJSONArray("protocols").toStringList(),
        modes = optJSONArray("modes").toObjectList {
            ModelConnectionMode(
                id = optString("id"),
                supported = optBoolean("supported", false),
                reason = optNullableString("reason"),
            )
        }.filter { it.id.isNotBlank() },
        modeField = optNullableString("modeField"),
        scope = optString("scope", "instance").ifBlank { "instance" },
        catalogAuto = catalog?.optBoolean("auto", false) ?: false,
        catalogManual = catalog?.optBoolean("manual", false) ?: false,
        apply = optString("apply", "restart").ifBlank { "restart" },
    )
}

internal fun JSONObject.toModelConnectionStatus(): ModelConnectionStatus? {
    val state = optNullableString("state") ?: return null
    return ModelConnectionStatus(
        state = state,
        protocol = optNullableString("protocol"),
        scope = optNullableString("scope"),
        mode = optNullableString("mode"),
        reason = optNullableString("reason"),
        externalOwner = optNullableString("externalOwner"),
    )
}

internal fun JSONObject?.toSecretFields(): Map<String, SecretFieldState> {
    if (this == null) return emptyMap()
    return keys().asSequence().mapNotNull { path ->
        val field = optJSONObject(path) ?: return@mapNotNull null
        path to SecretFieldState(
            set = field.optBoolean("set", false),
            hint = field.optNullableString("hint"),
        )
    }.toMap()
}

internal fun JSONObject.toModelPreviewTarget(): RemoteModelPreviewTarget {
    val models = optJSONObject("models")
    return RemoteModelPreviewTarget(
        connectorId = optString("connectorId"),
        runtimeId = optString("runtimeId"),
        runtimeType = optString("runtimeType"),
        name = optNullableString("name"),
        maturity = optNullableString("maturity"),
        decision = optString("decision", "skip").ifBlank { "skip" },
        reason = optNullableString("reason"),
        offerFormat = optNullableString("offerFormat"),
        effect = optNullableString("effect"),
        scope = optNullableString("scope"),
        requiresConfirmation = optBoolean("requiresConfirmation", false),
        runningSessions = optInt("runningSessions", 0),
        replacesHost = optJSONObject("replaces")?.optNullableString("host"),
        modelLimit = models?.optNullableInt("limit"),
        tooManyModels = optBoolean("tooManyModels", false),
        capabilityMaturity = optNullableString("capabilityMaturity"),
    )
}

internal fun JSONObject.toModelOperationResult(): RemoteModelOperationResult {
    return RemoteModelOperationResult(
        connectorId = optString("connectorId"),
        runtimeId = optString("runtimeId"),
        result = optString("result"),
        reason = optNullableString("reason"),
    )
}

internal fun JSONObject.toModelOperation(): RemoteModelOperation {
    return RemoteModelOperation(
        operationId = optNullableString("operationId"),
        kind = optString("kind"),
        finished = optBoolean("finished", true),
        results = optJSONArray("results").toObjectList { toModelOperationResult() },
    )
}

internal fun ModelOffer.toJson(): JSONObject {
    return JSONObject()
        .put("format", format)
        .put("baseUrl", baseUrl)
        .put(
            "models",
            JSONArray().apply {
                models.forEach { model ->
                    put(JSONObject().put("id", model.id).apply { model.name?.let { put("name", it) } })
                }
            },
        )
}
