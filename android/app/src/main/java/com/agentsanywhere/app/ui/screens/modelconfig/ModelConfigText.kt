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

/** What a runtime's channel state is called; null for a state this client does not know. */
@StringRes
internal fun channelStateRes(state: String): Int? = when (state) {
    "applied" -> R.string.model_config_channel_state_applied
    "pending" -> R.string.model_config_channel_state_pending
    "waiting_online" -> R.string.model_config_channel_state_waiting_online
    "switching" -> R.string.model_config_channel_state_switching
    "restoring" -> R.string.model_config_channel_state_restoring
    "restored" -> R.string.model_config_channel_state_restored
    "failed" -> R.string.model_config_channel_state_failed
    "unsupported" -> R.string.model_config_channel_state_unsupported
    else -> null
}

@StringRes
internal fun channelStepRes(step: String?): Int? = when (step) {
    "preparing" -> R.string.model_config_channel_step_preparing
    "activating" -> R.string.model_config_channel_step_activating
    "verifying" -> R.string.model_config_channel_step_verifying
    else -> null
}

/** Why a runtime cannot use, or did not switch to, the channel it should use. */
@StringRes
internal fun channelReasonRes(reason: String): Int = when (reason) {
    "model_connection_unsupported" -> R.string.model_config_reason_model_connection_unsupported
    "not_installed" -> R.string.model_config_reason_not_installed
    "format_unsupported" -> R.string.model_config_reason_format_unsupported
    "mode_unsupported" -> R.string.model_config_reason_mode_unsupported
    "models_required" -> R.string.model_config_reason_models_required
    "model_unavailable" -> R.string.model_config_reason_model_unavailable
    "confirmation_required" -> R.string.model_config_reason_confirmation_required
    "profile_unavailable" -> R.string.model_config_reason_profile_unavailable
    "validate_failed" -> R.string.model_config_reason_validate_failed
    "start_failed" -> R.string.model_config_reason_start_failed
    "verify_failed" -> R.string.model_config_reason_verify_failed
    "probe_failed" -> R.string.model_config_reason_probe_failed
    "verify_timeout" -> R.string.model_config_reason_verify_timeout
    "device_offline" -> R.string.model_config_reason_device_offline
    "rollback_failed" -> R.string.model_config_reason_rollback_failed
    "superseded" -> R.string.model_config_reason_superseded
    else -> R.string.model_config_reason_unknown
}

/** Localized text for a model configuration error code; generic text for anything else. */
@StringRes
internal fun modelConfigErrorRes(code: String?): Int = knownErrorRes(code) ?: R.string.model_config_error_generic

@StringRes
private fun knownErrorRes(code: String?): Int? = when (code) {
    "secret_unconfigured" -> R.string.model_config_error_secret_unconfigured
    "secret_required" -> R.string.model_config_error_secret_required
    "profile_changed" -> R.string.model_config_error_profile_changed
    "profile_in_use" -> R.string.model_config_error_profile_in_use
    "profile_read_only" -> R.string.model_config_error_profile_read_only
    "profile_detached" -> R.string.model_config_error_profile_detached
    "busy" -> R.string.model_config_error_busy
    "too_many_models" -> R.string.model_config_error_too_many_models
    "channel_not_found" -> R.string.model_config_error_channel_not_found
    "channel_in_use" -> R.string.model_config_error_channel_in_use
    "runtime_switching" -> R.string.model_config_error_runtime_switching
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
    "key_not_kept" -> R.string.model_config_error_key_not_kept
    else -> null
}
