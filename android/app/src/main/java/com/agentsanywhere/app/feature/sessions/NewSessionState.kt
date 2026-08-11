package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.model.AgentSession

data class NewSessionState(
    val title: String = "New Session",
    val selectedDeviceId: String? = null,
    val selectedRuntime: String? = null,
    val selectedWorkspacePath: String = "~",
    val homePath: String? = null,
    val currentPath: String = "~",
    val pathEntries: List<NewSessionPathEntry> = emptyList(),
    val isLoadingPath: Boolean = false,
    val isCreating: Boolean = false,
    val errorMessage: String? = null,
    val pathErrorMessage: String? = null,
)

data class NewSessionWorkspace(
    val title: String,
    val path: String,
    val detail: String,
    val home: Boolean = false,
)

data class NewSessionPathEntry(
    val name: String,
    val path: String,
    val isDirectory: Boolean,
    val size: Long?,
)

data class NewSessionDirectory(
    val path: String,
    val entries: List<NewSessionPathEntry>,
)

data class NewSessionAttachmentPart(
    val name: String,
    val mediaType: String,
    val bytes: ByteArray,
)

data class NewSessionCreateDraft(
    val connectorId: String,
    val runtime: String,
    val title: String?,
    val cwd: String?,
    val content: String,
    val selections: NewSessionSelections,
    val attachments: List<NewSessionAttachmentPart>,
    val clientMessageId: String,
    val knownSessionIds: Set<String>,
)

sealed interface NewSessionCreateOutcome {
    data class Created(
        val session: AgentSession,
        val recoveredAfterNetworkFailure: Boolean = false,
        val refreshedState: SessionsState? = null,
    ) : NewSessionCreateOutcome

    data class Failed(
        val error: Throwable,
        val outcomeUnknown: Boolean = false,
        val refreshedState: SessionsState? = null,
    ) : NewSessionCreateOutcome
}

class NewSessionCreateResultUnknownException(message: String) : IllegalStateException(message)

data class NewSessionSubmissionState(
    val inFlight: Boolean = false,
    val clientMessageId: String? = null,
    val outcomeUnknown: Boolean = false,
    val errorMessage: String? = null,
) {
    fun begin(newClientMessageId: () -> String): NewSessionSubmissionStart? {
        if (inFlight || outcomeUnknown) return null
        val messageId = clientMessageId?.takeIf(String::isNotBlank) ?: newClientMessageId()
        return NewSessionSubmissionStart(
            state = copy(
                inFlight = true,
                clientMessageId = messageId,
                errorMessage = null,
            ),
            clientMessageId = messageId,
        )
    }

    fun fail(message: String, outcomeUnknown: Boolean): NewSessionSubmissionState {
        return copy(
            inFlight = false,
            outcomeUnknown = outcomeUnknown,
            errorMessage = message,
        )
    }

    fun interrupted(message: String): NewSessionSubmissionState {
        if (!inFlight) return this
        return fail(message, outcomeUnknown = true)
    }
}

data class NewSessionSubmissionStart(
    val state: NewSessionSubmissionState,
    val clientMessageId: String,
)

internal fun SessionsState.newCreateCandidates(draft: NewSessionCreateDraft): List<AgentSession> {
    val expectedTitle = draft.title?.trim().orEmpty()
    val expectedCwd = draft.cwd?.trim().orEmpty()
    return (sessions + archivedSessions).filter { session ->
        session.id !in draft.knownSessionIds &&
            session.connectorId == draft.connectorId &&
            session.runtime == draft.runtime &&
            (expectedTitle.isEmpty() || session.title == expectedTitle) &&
            (session.cwd?.trim().orEmpty() == expectedCwd)
    }
}

fun workspaceOptionsFor(
    sessions: List<AgentSession>,
    deviceId: String?,
    homePath: String?,
): List<NewSessionWorkspace> {
    val home = homePath?.takeIf { it.isNotBlank() } ?: "~"
    val existing = sessions
        .asSequence()
        .filter { session -> deviceId == null || session.connectorId == deviceId }
        .mapNotNull { it.cwd?.trim()?.trimEnd('/')?.takeIf(String::isNotBlank) }
        .distinct()
        .filterNot { it == home }
        .map { path ->
            NewSessionWorkspace(
                title = workspaceTitle(path, homePath),
                path = path,
                detail = pathDisplay(path, homePath),
            )
        }
        .sortedBy { it.title.lowercase() }
        .toList()

    return listOf(
        NewSessionWorkspace(
            title = "Home directory",
            path = home,
            detail = pathDisplay(home, homePath),
            home = true,
        ),
    ) + existing
}

private fun workspaceTitle(path: String, homePath: String?): String {
    val home = homePath?.trimEnd('/')
    if (!home.isNullOrBlank() && path.trimEnd('/') == home) return "Home directory"
    return path.trimEnd('/').substringAfterLast('/').ifBlank { path }
}

private fun pathDisplay(path: String, homePath: String?): String {
    val home = homePath?.trimEnd('/')?.takeIf { it.isNotBlank() } ?: return path
    val clean = path.trimEnd('/')
    if (clean == home) return home
    if (!clean.startsWith("$home/")) return path
    return "~/${clean.removePrefix("$home/")}"
}
