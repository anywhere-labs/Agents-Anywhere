package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.api.RuntimeWorkflowApi
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import com.agentsanywhere.app.model.AgentSession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.UUID

/** UI continuations have their own channel, independent of a blocked create request. */
class RuntimeWorkflowCoordinator(
    private val api: RuntimeWorkflowApi,
    private val auth: AuthSessionReader,
    private val references: RuntimeWorkflowReferenceStore? = null,
) {
    private val mutableOperation = MutableStateFlow<JSONObject?>(null)
    val operation = mutableOperation.asStateFlow()
    private val mutableError = MutableStateFlow<Throwable?>(null)
    val error = mutableError.asStateFlow()
    private val mutableBinding = MutableStateFlow(false)
    val binding = mutableBinding.asStateFlow()
    private val stateLock = Any()
    private var generation = 0
    private val responseIds = mutableMapOf<String, String>()
    private data class Scope(val generation: Int, val server: String, val user: String, val token: String)

    private fun scope() = synchronized(stateLock) {
        Scope(generation, auth.readServerUrl(), auth.readUserId(), auth.readAccessToken())
    }
    private fun current(target: Scope) = target.generation == generation &&
        target.server == auth.readServerUrl() && target.user == auth.readUserId() && target.token == auth.readAccessToken()

    private fun publish(target: Scope, operationId: String? = null, action: () -> Unit): Boolean = synchronized(stateLock) {
        if (!current(target) || (operationId != null && mutableOperation.value?.optString("id") != operationId)) false
        else { action(); true }
    }

    fun clear() = synchronized(stateLock) {
        generation++
        mutableOperation.value = null
        mutableError.value = null
        mutableBinding.value = false
        responseIds.clear()
    }

    suspend fun run(path: String, body: JSONObject, done: (JSONObject) -> Boolean): JSONObject {
        clear()
        val target = scope()
        require(target.server.isNotBlank() && target.token.isNotBlank())
        val id = body.optString("createOperationId")
        requireWorkflow(publish(target) {
            if (path == "creations" && id.isNotBlank()) references?.remember(target.server, target.user, id)
        }, RuntimeWorkflowFailure.Reason.TargetChanged)
        var value = withContext(Dispatchers.IO) { api.post(target.server, target.token, path, body) }
        while (true) {
            requireWorkflow(publish(target) { mutableOperation.value = value }, RuntimeWorkflowFailure.Reason.TargetChanged)
            val state = value.getJSONObject("state")
            if (done(state)) {
                requireWorkflow(publish(target) {
                    if (value.optString("kind") != "creation") mutableOperation.value = null
                }, RuntimeWorkflowFailure.Reason.TargetChanged)
                return value
            }
            check(state.optString("phase") !in setOf("failed", "rejected", "expired", "cancelled", "outcome_unknown")) {
                state.optJSONObject("failure")?.optString("message") ?: state.optString("phase")
            }
            delay(1000)
            value = withContext(Dispatchers.IO) { api.get(target.server, target.token, value.getString("kind"), value.getString("id")) }
        }
    }

    /** Acceptance and binding are different facts. Only a verified session read
     * commits binding and releases the account-scoped recovery reference. */
    suspend fun bindAcceptedCreation(load: suspend (String, String, String) -> AgentSession): AgentSession {
        val target = scope()
        val value = mutableOperation.value ?: throw RuntimeWorkflowFailure(RuntimeWorkflowFailure.Reason.CreationMissing)
        val id = value.getString("id")
        require(value.optString("kind") == "creation" && value.getJSONObject("state").optBoolean("messageAccepted"))
        val sessionId = value.getString("sessionId")
        requireWorkflow(publish(target, id) { requireWorkflow(!mutableBinding.value, RuntimeWorkflowFailure.Reason.BindingInProgress); mutableBinding.value = true }, RuntimeWorkflowFailure.Reason.TargetChanged)
        try {
            val session = withContext(Dispatchers.IO) { load(target.server, target.token, sessionId) }
            requireWorkflow(session.id == sessionId, RuntimeWorkflowFailure.Reason.SessionMismatch)
            requireWorkflow(publish(target, id) {
                references?.remember(target.server, target.user, id, remove = true)
                mutableOperation.value = null; mutableError.value = null
            }, RuntimeWorkflowFailure.Reason.TargetChanged)
            return session
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { publish(target, id) { mutableError.value = error }; throw error }
        finally { publish(target) { mutableBinding.value = false } }
    }

    fun dismiss() = synchronized(stateLock) {
        val value = mutableOperation.value
        val state = value?.optJSONObject("state")
        if (value != null && state?.has("messageAccepted") == true && !state.isNull("messageAccepted") &&
            !state.optBoolean("messageAccepted") && state.optString("phase") in setOf("failed", "rejected", "cancelled")) {
            references?.remember(auth.readServerUrl(), auth.readUserId(), value.getString("id"), remove = true)
        }
        clear()
    }

    suspend fun restore() {
        clear()
        val target = scope()
        val id = references?.read(target.server, target.user)?.firstOrNull() ?: return
        try {
            val next = withContext(Dispatchers.IO) { api.get(target.server, target.token, "creation", id) }
            publish(target) { mutableOperation.value = next }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { publish(target) { mutableError.value = error } }
    }

    suspend fun refresh() {
        val target = scope()
        val value = mutableOperation.value ?: return
        refresh(target, value)
    }

    private suspend fun refresh(target: Scope, value: JSONObject) {
        val id = value.getString("id")
        try {
            val next = withContext(Dispatchers.IO) { api.get(target.server, target.token, value.getString("kind"), id) }
            publish(target, id) {
                mutableOperation.value = next
            }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { publish(target, id) { mutableError.value = error } }
    }

    suspend fun respond(request: JSONObject, action: String, input: JSONObject?) {
        val target = scope()
        val value = mutableOperation.value ?: return
        val id = value.getString("id")
        val body = JSONObject().put("interactionId", request.getString("interactionId"))
            .put("ownerGeneration", request.getString("ownerGeneration")).put("requestRevision", request.getLong("requestRevision"))
            .put("actionId", action)
        input?.let { body.put("input", it) }
        val key = body.toString()
        if (!publish(target, id) { body.put("responseOperationId", responseIds.getOrPut(key) { UUID.randomUUID().toString() }) }) return
        try {
            withContext(Dispatchers.IO) { api.post(target.server, target.token, "${value.getString("kind")}/${id.urlEncoded()}/responses", body) }
            if (publish(target, id) { mutableError.value = null }) refresh(target, value)
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { publish(target, id) { mutableError.value = error } }
    }

    suspend fun cancel() {
        val target = scope()
        val value = mutableOperation.value ?: return
        val id = value.getString("id")
        try {
            val next = withContext(Dispatchers.IO) {
                api.post(target.server, target.token, "${value.getString("kind")}/${id.urlEncoded()}/cancel", JSONObject().put("operationId", UUID.randomUUID().toString()))
            }
            publish(target, id) { mutableOperation.value = next }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { publish(target, id) { mutableError.value = error } }
    }
}
private fun String.urlEncoded(): String = java.net.URLEncoder.encode(this, "UTF-8").replace("+", "%20")

data class PreparedRuntimeWorkspace(
    val preparationId: String,
    val expectedRevision: Long,
    val catalogRevision: Long,
    val catalog: NewSessionModelCatalog,
    val configurationSchema: String? = null,
    val configurationValues: Map<String, Any> = emptyMap(),
    val inputModalitiesByModel: Map<String, List<String>> = emptyMap(),
    val defaultModelId: String? = null,
) {
    fun inputModalities(selectionId: String?): List<String>? {
        // Only an absent selection means the Agent default; an unknown one has no declaration.
        if (selectionId.isNullOrBlank()) return defaultModelId?.let(inputModalitiesByModel::get)
        val model = catalog.models.firstOrNull { item ->
            item.selectionId == selectionId || item.reasoningItems.any { it.selectionId == selectionId }
        } ?: return null
        return inputModalitiesByModel[model.id]
    }
}

internal class RuntimeWorkflowFailure(val reason: Reason) : IllegalStateException() {
    enum class Reason { TargetChanged, BindingInProgress, CreationMissing, SessionMismatch }
}

private fun requireWorkflow(condition: Boolean, reason: RuntimeWorkflowFailure.Reason) {
    if (!condition) throw RuntimeWorkflowFailure(reason)
}
