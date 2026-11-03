package com.agentsanywhere.app.ui.screens.modelconfig

import androidx.annotation.StringRes
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.modelconfig.ModelStatusTone
import com.agentsanywhere.app.feature.modelconfig.RuntimeMaturityBadge
import com.agentsanywhere.app.feature.modelconfig.runtimeMaturityBadge
import com.agentsanywhere.app.ui.designsystem.LocalAAColors

/** "Beta" / "Experimental" for a runtime's maturity; null for stable or unknown. */
@Composable
fun runtimeMaturityLabel(maturity: String?): String? = when (runtimeMaturityBadge(maturity)) {
    RuntimeMaturityBadge.Beta -> stringResource(R.string.runtime_maturity_beta)
    RuntimeMaturityBadge.Experimental -> stringResource(R.string.runtime_maturity_experimental)
    null -> null
}

/** Shown beside a runtime's status, never instead of it. Stable shows nothing. */
@Composable
fun RuntimeMaturityBadge(maturity: String?, modifier: Modifier = Modifier) {
    val badge = runtimeMaturityBadge(maturity) ?: return
    val label = runtimeMaturityLabel(maturity) ?: return
    val description = stringResource(
        when (badge) {
            RuntimeMaturityBadge.Beta -> R.string.runtime_maturity_beta_description
            RuntimeMaturityBadge.Experimental -> R.string.runtime_maturity_experimental_description
        },
    )
    StatusPill(
        label = label,
        tone = ModelStatusTone.Neutral,
        modifier = modifier.semantics { contentDescription = "$label. $description" },
    )
}

@Composable
internal fun StatusPill(label: String, tone: ModelStatusTone, modifier: Modifier = Modifier) {
    val color = toneColor(tone)
    Text(
        text = label,
        modifier = modifier
            .border(1.dp, color.copy(alpha = 0.45f), CircleShape)
            .padding(horizontal = 7.dp, vertical = 2.dp),
        color = color,
        fontSize = 10.5.sp,
        lineHeight = 13.sp,
        fontWeight = FontWeight.SemiBold,
        maxLines = 1,
    )
}

@Composable
internal fun toneColor(tone: ModelStatusTone): Color {
    val colors = LocalAAColors.current
    return when (tone) {
        ModelStatusTone.Ok -> colors.runtimeRunning
        ModelStatusTone.Progress -> colors.runtimeTransitioning
        ModelStatusTone.Warning -> colors.noticeWarning
        ModelStatusTone.Error -> colors.errorText
        ModelStatusTone.Neutral -> colors.muted
    }
}

@StringRes
internal fun protocolLabelRes(protocol: String?): Int? = when (protocol) {
    "openai_responses" -> R.string.model_config_protocol_openai_responses
    "openai_chat" -> R.string.model_config_protocol_openai_chat
    "anthropic" -> R.string.model_config_protocol_anthropic
    else -> null
}

@Composable
internal fun protocolLabel(protocol: String): String =
    protocolLabelRes(protocol)?.let { stringResource(it) } ?: protocol

/** Short enough for a tag; the full name shows in the expanded details. */
internal fun protocolShortLabel(protocol: String): String = when (protocol) {
    "openai_responses" -> "Responses"
    "openai_chat" -> "Chat Completions"
    "anthropic" -> "Anthropic"
    else -> protocol
}

@StringRes
internal fun effectLabelRes(effect: String?): Int? = when (effect) {
    "new_instance" -> R.string.model_config_effect_new_instance
    "immediate" -> R.string.model_config_effect_immediate
    "new_session" -> R.string.model_config_effect_new_session
    "restart" -> R.string.model_config_effect_restart
    else -> null
}

@StringRes
internal fun skipReasonRes(reason: String?): Int = when (reason) {
    "model_connection_unsupported" -> R.string.model_config_skip_model_connection_unsupported
    "not_installed" -> R.string.model_config_skip_not_installed
    "format_unsupported" -> R.string.model_config_skip_format_unsupported
    "mode_unsupported" -> R.string.model_config_skip_mode_unsupported
    "busy_operation" -> R.string.model_config_skip_busy_operation
    "device_offline" -> R.string.model_config_skip_device_offline
    "models_required" -> R.string.model_config_skip_models_required
    else -> R.string.model_config_skip_unknown
}

@StringRes
internal fun assignmentStatusRes(status: String): Int? = when (status) {
    "applying" -> R.string.model_config_assignment_applying
    "failed" -> R.string.model_config_assignment_failed
    "modified" -> R.string.model_config_assignment_modified
    "outdated" -> R.string.model_config_assignment_outdated
    "applied" -> R.string.model_config_assignment_applied
    else -> null
}

@StringRes
internal fun connectionStateRes(state: String): Int? = when (state) {
    "not_configured" -> R.string.model_config_state_not_configured
    "saved_pending" -> R.string.model_config_state_saved_pending
    "applied" -> R.string.model_config_state_applied
    "failed" -> R.string.model_config_state_failed
    "managed_externally" -> R.string.model_config_state_managed_externally
    else -> null
}

/** Localized text for a model configuration error code; generic text for anything else. */
@StringRes
internal fun modelConfigErrorRes(code: String?): Int = when (code) {
    "secret_unconfigured" -> R.string.model_config_error_secret_unconfigured
    "secret_required" -> R.string.model_config_error_secret_required
    "profile_changed" -> R.string.model_config_error_profile_changed
    "profile_in_use" -> R.string.model_config_error_profile_in_use
    "profile_read_only" -> R.string.model_config_error_profile_read_only
    "profile_detached" -> R.string.model_config_error_profile_detached
    "busy" -> R.string.model_config_error_busy
    "operation_in_progress" -> R.string.model_config_error_operation_in_progress
    "idempotency_key_reused" -> R.string.model_config_error_idempotency_key_reused
    "too_many_models" -> R.string.model_config_error_too_many_models
    "confirmation_required" -> R.string.model_config_error_confirmation_required
    "tokens_unconfigured" -> R.string.model_config_error_tokens_unconfigured
    "tokens_not_linked" -> R.string.model_config_error_tokens_not_linked
    "reauth_required" -> R.string.model_config_error_reauth_required
    "tokens_unavailable" -> R.string.model_config_error_tokens_unavailable
    "tokens_not_synced" -> R.string.model_config_error_tokens_not_synced
    "key_rejected" -> R.string.model_config_error_key_rejected
    "catalog_empty" -> R.string.model_config_error_catalog_empty
    "link_expired" -> R.string.model_config_error_link_expired
    "invalid_state" -> R.string.model_config_error_invalid_state
    "invalid_issuer" -> R.string.model_config_error_invalid_issuer
    "access_denied" -> R.string.model_config_error_access_denied
    "authorization_failed" -> R.string.model_config_error_authorization_failed
    "exchange_failed" -> R.string.model_config_error_exchange_failed
    "model_connection_unsupported" -> R.string.model_config_error_model_connection_unsupported
    "device_offline" -> R.string.model_config_error_device_offline
    "models_required" -> R.string.model_config_error_models_required
    "key_rotated" -> R.string.model_config_error_key_rotated
    else -> R.string.model_config_error_generic
}
