package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.ApiException

/**
 * Slash-command rules shared with Web, Desktop and iOS
 * (web-next/src/components/session/runtime-command-model.ts). Only drafts
 * naming a catalog command run as commands; paths and prose stay messages.
 */
data class SlashIntent(
    val command: String,
    val suffix: String,
    val raw: String,
    val multiline: Boolean,
) {
    /** A slash token that could name a command; paths such as "/Users/me" never do. */
    val isCommandLike: Boolean
        get() = command.isEmpty() || COMMAND_TOKEN.matches(command)

    companion object {
        private val COMMAND_TOKEN = Regex("[a-z0-9][a-z0-9_:.\\-]*")

        fun parse(raw: String): SlashIntent? {
            val trimmed = raw.trimStart()
            if (!trimmed.startsWith('/')) return null
            val body = trimmed.substring(1)
            val token = body.takeWhile { !it.isWhitespace() }
            return SlashIntent(
                command = token.lowercase(),
                suffix = body.substring(token.length),
                raw = raw,
                multiline = raw.any { it == '\n' || it == '\r' },
            )
        }
    }
}

sealed interface RuntimeCommandUi {
    data class Execute(
        val argumentHint: String? = null,
        val acceptsMultiline: Boolean = false,
        val allowedStatuses: List<String>? = null,
    ) : RuntimeCommandUi

    data class Selector(val target: String) : RuntimeCommandUi
}

enum class RuntimeCommandBlock { Disabled, Busy, ReadOnly, Offline, Unavailable }

data class RuntimeCommandRequest(
    val command: String,
    val args: List<String>,
    val raw: String,
)

enum class RuntimeCommandExecutionState { Accepted, Completed, Unknown }

data class RuntimeCommandOutcome(
    val ok: Boolean,
    val state: RuntimeCommandExecutionState,
    val message: String?,
    val code: String?,
) {
    companion object {
        fun fromResponse(ok: Boolean, code: String?, message: String?, result: Map<String, Any?>): RuntimeCommandOutcome {
            val state = when (result["executionState"]) {
                "accepted" -> RuntimeCommandExecutionState.Accepted
                "completed" -> RuntimeCommandExecutionState.Completed
                "unknown" -> RuntimeCommandExecutionState.Unknown
                else -> when {
                    code == "command_outcome_unknown" -> RuntimeCommandExecutionState.Unknown
                    ok -> RuntimeCommandExecutionState.Accepted
                    else -> RuntimeCommandExecutionState.Completed
                }
            }
            val text = result["text"] as? String
            return RuntimeCommandOutcome(
                ok = ok && state != RuntimeCommandExecutionState.Unknown,
                state = state,
                message = if (ok) text ?: message else message ?: text,
                code = code,
            )
        }

        /** Only definite 4xx rejections are known failures; anything else may have run. */
        fun fromTransportFailure(error: Throwable): RuntimeCommandOutcome {
            val status = (error as? ApiException)?.statusCode
            // Requests that never reached the server cannot have run.
            val unsent = generateSequence(error) { it.cause }.take(4)
                .any { it is java.net.UnknownHostException || it is java.net.ConnectException }
            val known = unsent || (status != null && status in 400..499 && status != 408)
            return RuntimeCommandOutcome(
                ok = false,
                state = if (known) RuntimeCommandExecutionState.Completed else RuntimeCommandExecutionState.Unknown,
                message = error.message,
                code = if (known) "command_rejected" else "command_outcome_unknown",
            )
        }
    }
}

/**
 * Older catalogs predate `metadata.ui`: they keep plain execute behavior,
 * without opting in to multiline or busy-state execution.
 */
val RuntimeCommand.ui: RuntimeCommandUi?
    get() {
        if (!metadata.containsKey("ui")) return RuntimeCommandUi.Execute()
        val ui = metadata["ui"] as? Map<*, *> ?: return null
        return when (ui["kind"]) {
            "selector" -> (ui["target"] as? String)
                ?.takeIf { it in SELECTOR_TARGETS }
                ?.let(RuntimeCommandUi::Selector)
            "execute" -> RuntimeCommandUi.Execute(
                argumentHint = ui["argumentHint"] as? String,
                acceptsMultiline = ui["acceptsMultiline"] == true,
                allowedStatuses = (ui["allowedStatuses"] as? List<*>)?.filterIsInstance<String>(),
            )
            else -> null
        }
    }

private val SELECTOR_TARGETS = setOf("model", "reasoning", "permission", "collaborationMode")

val RuntimeCommand.argumentHint: String?
    get() = (ui as? RuntimeCommandUi.Execute)?.argumentHint

/** Prefix match on id, title or alias. */
fun RuntimeCommand.matchesPrefix(query: String): Boolean {
    val normalized = query.lowercase()
    if (normalized.isEmpty()) return true
    return (listOf(id, title) + aliases).any { it.lowercase().startsWith(normalized) }
}

val SessionRuntimeStatus.wireValue: String
    get() = when (this) {
        SessionRuntimeStatus.Idle -> "idle"
        SessionRuntimeStatus.Waiting -> "waiting"
        SessionRuntimeStatus.Pending -> "pending"
        SessionRuntimeStatus.Running -> "running"
        SessionRuntimeStatus.Stopping -> "stopping"
        SessionRuntimeStatus.WaitingApproval -> "waiting_approval"
        SessionRuntimeStatus.Blocked -> "blocked"
        SessionRuntimeStatus.Disconnected -> "disconnected"
        SessionRuntimeStatus.Error -> "error"
        SessionRuntimeStatus.Unknown -> "unknown"
    }

fun RuntimeCommand.allowed(status: SessionRuntimeStatus): Boolean {
    val ui = ui
    if (!enabled || ui == null) return false
    val allowedStatuses = (ui as? RuntimeCommandUi.Execute)?.allowedStatuses
    return allowedStatuses?.contains(status.wireValue)
        ?: (status == SessionRuntimeStatus.Idle || status == SessionRuntimeStatus.Error)
}

fun RuntimeCommand.block(
    status: SessionRuntimeStatus,
    capability: Boolean,
    writable: Boolean,
    online: Boolean,
): RuntimeCommandBlock? = when {
    // A command whose `metadata.ui` this client does not understand is never run.
    !enabled || ui == null -> RuntimeCommandBlock.Disabled
    !online -> RuntimeCommandBlock.Offline
    !capability -> RuntimeCommandBlock.Unavailable
    !writable -> RuntimeCommandBlock.ReadOnly
    !allowed(status) -> RuntimeCommandBlock.Busy
    else -> null
}

fun RuntimeCommand.request(intent: SlashIntent): RuntimeCommandRequest? {
    if (intent.multiline && (ui as? RuntimeCommandUi.Execute)?.acceptsMultiline != true) return null
    val suffix = intent.suffix.trim()
    if (suffix.isNotEmpty() && !acceptsArgs) return null
    val args = when {
        suffix.isEmpty() -> emptyList()
        // String arguments are one free-form value, not an array of words.
        argsSchema?.get("type") == "string" ->
            listOf(if (intent.suffix.first().isWhitespace()) intent.suffix.substring(1) else intent.suffix)
        else -> suffix.split(Regex("\\s+"))
    }
    return RuntimeCommandRequest(command = id, args = args, raw = intent.raw)
}

fun List<RuntimeCommand>.exact(intent: SlashIntent): RuntimeCommand? =
    firstOrNull { command ->
        command.id.lowercase() == intent.command || command.aliases.any { it.lowercase() == intent.command }
    }
