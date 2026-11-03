package com.agentsanywhere.app.api

import com.agentsanywhere.app.model.ModelOffer
import com.agentsanywhere.app.model.ModelProfile
import com.agentsanywhere.app.model.QuickSetupRequest
import org.json.JSONArray
import org.json.JSONObject

/**
 * Model profiles, their assignments to runtimes and the Tokens Anywhere link.
 * Keys go in and never come back; the overview arrives with the dashboard snapshot.
 */
class ModelConfigApi(
    private val client: ApiClient = ApiClient(),
) {
    fun createProfile(
        serverUrl: String,
        authorizationToken: String,
        name: String,
        apiKey: String,
        offers: List<ModelOffer>,
    ): ModelProfile {
        val body = JSONObject()
            .put("name", name)
            .put("apiKey", apiKey)
            .put("offers", JSONArray().apply { offers.forEach { put(it.toJson()) } })
        return client.postJson(
            serverUrl = serverUrl,
            path = "/model-profiles",
            body = body,
            authorizationToken = authorizationToken,
        ).toModelProfile()
    }

    fun deleteProfile(
        serverUrl: String,
        authorizationToken: String,
        profileId: String,
    ) {
        client.deleteJson(
            serverUrl = serverUrl,
            path = "/model-profiles/${profileId.urlEncode()}",
            authorizationToken = authorizationToken,
        )
    }

    fun preview(
        serverUrl: String,
        authorizationToken: String,
        profileId: String,
    ): List<RemoteModelPreviewTarget> {
        return client.postJson(
            serverUrl = serverUrl,
            path = "/model-config/assignments/preview",
            body = JSONObject().put("profileId", profileId),
            authorizationToken = authorizationToken,
        ).optJSONArray("targets").toObjectList { toModelPreviewTarget() }
    }

    fun apply(
        serverUrl: String,
        authorizationToken: String,
        profileId: String,
        targets: List<RemoteModelTarget>,
        allowInterrupt: Boolean,
        confirmNativeGlobal: Boolean,
        idempotencyKey: String,
    ): RemoteModelOperation {
        val body = JSONObject()
            .put("profileId", profileId)
            .put(
                "targets",
                JSONArray().apply {
                    targets.forEach { put(JSONObject().put("connectorId", it.connectorId).put("runtimeId", it.runtimeId)) }
                },
            )
            .put("allowInterrupt", allowInterrupt)
            .put("confirmNativeGlobal", confirmNativeGlobal)
        return client.postJson(
            serverUrl = serverUrl,
            path = "/model-config/assignments",
            body = body,
            authorizationToken = authorizationToken,
            headers = mapOf(IDEMPOTENCY_KEY to idempotencyKey),
        ).toModelOperation()
    }

    fun restore(
        serverUrl: String,
        authorizationToken: String,
        connectorId: String,
        runtimeId: String,
        allowInterrupt: Boolean,
    ): RemoteModelOperationResult {
        return client.deleteJson(
            serverUrl = serverUrl,
            path = "/model-config/assignments/${connectorId.urlEncode()}/${runtimeId.urlEncode()}" +
                "?allow_interrupt=$allowInterrupt",
            authorizationToken = authorizationToken,
        ).toModelOperationResult()
    }

    /** A one-time address to open in the browser; the link finishes there. */
    fun beginTokensLink(
        serverUrl: String,
        authorizationToken: String,
    ): String {
        return client.postJson(
            serverUrl = serverUrl,
            path = "/integrations/tokens/link",
            authorizationToken = authorizationToken,
        ).getString("startUrl")
    }

    /** Runtimes the one-click Tokens Anywhere setup can reach, with what it would do to each. */
    fun quickSetupCandidates(
        serverUrl: String,
        authorizationToken: String,
    ): List<RemoteModelPreviewTarget> {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/integrations/tokens/quick-setup",
            authorizationToken = authorizationToken,
        ).optJSONArray("targets").toObjectList { toModelPreviewTarget() }
    }

    /** Starts the setup; a [RemoteQuickSetupStart.startUrl] must be opened in the browser first. */
    fun startQuickSetup(
        serverUrl: String,
        authorizationToken: String,
        request: QuickSetupRequest,
    ): RemoteQuickSetupStart {
        val body = JSONObject()
            .put(
                "targets",
                JSONArray().apply {
                    request.targets.forEach { put(JSONObject().put("connectorId", it.connectorId).put("runtimeId", it.runtimeId)) }
                },
            )
            .put("confirmNativeGlobal", request.confirmNativeGlobal)
        val response = client.postJson(
            serverUrl = serverUrl,
            path = "/integrations/tokens/quick-setup",
            body = body,
            authorizationToken = authorizationToken,
        )
        return RemoteQuickSetupStart(
            started = response.optBoolean("started", false),
            startUrl = response.optNullableString("startUrl"),
        )
    }

    fun syncTokens(
        serverUrl: String,
        authorizationToken: String,
    ): ModelProfile {
        return client.postJson(
            serverUrl = serverUrl,
            path = "/integrations/tokens/sync",
            authorizationToken = authorizationToken,
        ).toModelProfile()
    }

    fun unlinkTokens(
        serverUrl: String,
        authorizationToken: String,
        allowInterrupt: Boolean,
    ): RemoteTokensUnlinkResult {
        val response = client.deleteJson(
            serverUrl = serverUrl,
            path = "/integrations/tokens/link?allow_interrupt=$allowInterrupt",
            authorizationToken = authorizationToken,
        )
        return RemoteTokensUnlinkResult(
            revoked = response.optBoolean("revoked", false),
            results = response.optJSONArray("results").toObjectList { toModelOperationResult() },
        )
    }

    fun rotateTokensKey(
        serverUrl: String,
        authorizationToken: String,
        profileId: String,
        allowInterrupt: Boolean,
        idempotencyKey: String,
    ): RemoteModelOperation {
        return client.postJson(
            serverUrl = serverUrl,
            path = "/model-profiles/${profileId.urlEncode()}/rotate-key",
            body = JSONObject().put("allowInterrupt", allowInterrupt),
            authorizationToken = authorizationToken,
            headers = mapOf(IDEMPOTENCY_KEY to idempotencyKey),
        ).toModelOperation()
    }

    private companion object {
        const val IDEMPOTENCY_KEY = "Idempotency-Key"
    }
}
