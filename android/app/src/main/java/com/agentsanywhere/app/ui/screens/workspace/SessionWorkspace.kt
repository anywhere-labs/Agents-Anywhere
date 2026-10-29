package com.agentsanywhere.app.ui.screens.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.ui.designsystem.AAWordmark
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable

/** Screen width (dp) from which the persistent sidebar + detail layout is used. */
const val WIDE_LAYOUT_MIN_WIDTH_DP = 720

/**
 * Smallest screen width (dp) that identifies a tablet, regardless of orientation.
 * Phones stay below this even in landscape, so they keep the single-pane UI.
 */
const val TABLET_MIN_SMALLEST_WIDTH_DP = 600

/**
 * True only on tablets with room for the sidebar + conversation split.
 * A large `screenWidthDp` alone also matches landscape phones (and free-form
 * windows), which must keep the normal phone layout.
 */
@Composable
fun rememberWideLayout(): Boolean {
    val configuration = LocalConfiguration.current
    return configuration.smallestScreenWidthDp >= TABLET_MIN_SMALLEST_WIDTH_DP &&
        configuration.screenWidthDp >= WIDE_LAYOUT_MIN_WIDTH_DP
}

/**
 * Tablet workspace: the session list becomes a permanent sidebar next to the open
 * conversation instead of a full-screen screen you have to navigate away from.
 */
@Composable
fun SessionWorkspace(
    sidebar: @Composable () -> Unit,
    detail: @Composable () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAAColors.current
    val configuration = LocalConfiguration.current
    val sidebarWidth = (configuration.screenWidthDp * 0.34f).dp.coerceIn(300.dp, 400.dp)

    Row(
        modifier = modifier
            .fillMaxSize()
            .background(colors.canvas),
    ) {
        Box(
            modifier = Modifier
                .width(sidebarWidth)
                .fillMaxHeight(),
        ) {
            sidebar()
        }
        Box(
            modifier = Modifier
                .width(1.dp)
                .fillMaxHeight()
                .background(colors.border),
        )
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxHeight(),
        ) {
            detail()
        }
    }
}

/** Shown in the detail pane on tablets while no conversation is selected. */
@Composable
fun WorkspaceEmptyState(
    onNewSession: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAAColors.current

    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 360.dp)
                .padding(horizontal = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            AAWordmark(
                color = colors.faint,
                fontSize = 26.sp,
                lineHeight = 32.sp,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(10.dp))
            Text(
                text = stringResource(R.string.workspace_empty_title),
                color = colors.ink,
                fontSize = 21.sp,
                fontWeight = FontWeight.Medium,
                textAlign = TextAlign.Center,
            )
            Text(
                text = stringResource(R.string.workspace_empty_message),
                color = colors.muted,
                fontSize = 14.sp,
                lineHeight = 21.sp,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(6.dp))
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(12.dp))
                    .background(colors.primaryAction)
                    .noRippleClickable(onClick = onNewSession)
                    .padding(horizontal = 18.dp, vertical = 11.dp),
            ) {
                Text(
                    text = stringResource(R.string.home_new_session),
                    color = colors.onPrimaryAction,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                )
            }
        }
    }
}
