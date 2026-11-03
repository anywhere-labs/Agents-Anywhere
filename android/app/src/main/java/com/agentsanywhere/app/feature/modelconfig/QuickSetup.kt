package com.agentsanywhere.app.feature.modelconfig

import com.agentsanywhere.app.api.RemoteModelPreviewTarget
import com.agentsanywhere.app.model.ModelTarget
import com.agentsanywhere.app.model.QuickSetupRequest
import com.agentsanywhere.app.model.TokensLinkStatus

/** Which face the Tokens Anywhere quick setup card shows. */
enum class QuickSetupPhase { Setup, Progress, Done }

enum class QuickStepStatus { Pending, Active, Done, Failed }

data class QuickSetupSteps(
    val authorize: QuickStepStatus,
    val sync: QuickStepStatus,
    val apply: QuickStepStatus,
)

/**
 * Choosing what to set up, a setup on its way (including the browser
 * authorization this screen started), or the result once runtimes use the
 * Tokens profile.
 */
fun quickSetupPhase(tokens: TokensLinkStatus, configured: Boolean, authorizing: Boolean): QuickSetupPhase {
    val state = tokens.quickSetup?.state
    if (authorizing && !tokens.linked) return QuickSetupPhase.Progress
    if (state == "syncing" || state == "applying" || state == "failed") {
        return if (tokens.linked) QuickSetupPhase.Progress else QuickSetupPhase.Setup
    }
    if (tokens.linked && (configured || state == "done")) return QuickSetupPhase.Done
    return QuickSetupPhase.Setup
}

fun quickSetupSteps(tokens: TokensLinkStatus, authorizing: Boolean): QuickSetupSteps {
    val progress = tokens.quickSetup
    if (!tokens.linked) {
        return QuickSetupSteps(
            authorize = if (authorizing) QuickStepStatus.Active else QuickStepStatus.Pending,
            sync = QuickStepStatus.Pending,
            apply = QuickStepStatus.Pending,
        )
    }
    if (progress == null) return QuickSetupSteps(QuickStepStatus.Done, QuickStepStatus.Pending, QuickStepStatus.Pending)
    return when (progress.state) {
        "failed" -> if (progress.step == "sync") {
            QuickSetupSteps(QuickStepStatus.Done, QuickStepStatus.Failed, QuickStepStatus.Pending)
        } else {
            QuickSetupSteps(QuickStepStatus.Done, QuickStepStatus.Done, QuickStepStatus.Failed)
        }
        "syncing" -> QuickSetupSteps(QuickStepStatus.Done, QuickStepStatus.Active, QuickStepStatus.Pending)
        "applying" -> QuickSetupSteps(QuickStepStatus.Done, QuickStepStatus.Done, QuickStepStatus.Active)
        else -> QuickSetupSteps(QuickStepStatus.Done, QuickStepStatus.Done, QuickStepStatus.Done)
    }
}

/** Ticked by default: everything that can be applied without changing a runtime's own global settings. */
fun defaultQuickSelection(candidates: List<RemoteModelPreviewTarget>): Set<String> =
    candidates.filter { it.canApply && !it.requiresConfirmation }.mapTo(linkedSetOf()) { it.key }

/** A runtime that uses the Tokens profile, for telling which candidates are new. */
data class QuickAssigned(
    val connectorId: String,
    val runtimeId: String,
    val runtimeType: String?,
    val createdRuntime: Boolean,
)

/**
 * Runtimes that could use Tokens Anywhere but do not yet. A runtime served by a
 * managed instance counts as set up: the instance carries the assignment.
 */
fun newQuickCandidates(
    candidates: List<RemoteModelPreviewTarget>,
    assigned: List<QuickAssigned>,
): List<RemoteModelPreviewTarget> {
    val taken = assigned.mapTo(mutableSetOf()) { "${it.connectorId}/${it.runtimeId}" }
    val managed = assigned
        .filter { it.createdRuntime && it.runtimeType != null }
        .mapTo(mutableSetOf()) { "${it.connectorId}/${it.runtimeType}" }
    return candidates.filter { item ->
        item.canApply &&
            item.key !in taken &&
            !(item.effect == "new_instance" && "${item.connectorId}/${item.runtimeType}" in managed)
    }
}

/** The request for the ticked candidates; global changes are confirmed by ticking them. */
fun quickSetupRequest(candidates: List<RemoteModelPreviewTarget>, selected: Set<String>): QuickSetupRequest {
    val chosen = candidates.filter { it.canApply && it.key in selected }
    return QuickSetupRequest(
        targets = chosen.map { ModelTarget(it.connectorId, it.runtimeId) },
        confirmNativeGlobal = chosen.any { it.requiresConfirmation },
    )
}

/** What a candidate's row says under its name. */
sealed interface QuickCandidateNote {
    data class Skipped(val reason: String?) : QuickCandidateNote
    data object ChangesOwnSettings : QuickCandidateNote
    data object ManagedInstance : QuickCandidateNote
    data object AppliesWhenIdle : QuickCandidateNote
    data class Effect(val effect: String) : QuickCandidateNote
}

fun quickCandidateNote(item: RemoteModelPreviewTarget): QuickCandidateNote = when {
    !item.canApply -> QuickCandidateNote.Skipped(item.reason)
    item.requiresConfirmation -> QuickCandidateNote.ChangesOwnSettings
    item.effect == "new_instance" -> QuickCandidateNote.ManagedInstance
    item.effect == "restart" && item.runningSessions > 0 -> QuickCandidateNote.AppliesWhenIdle
    else -> QuickCandidateNote.Effect(item.effect ?: "restart")
}
