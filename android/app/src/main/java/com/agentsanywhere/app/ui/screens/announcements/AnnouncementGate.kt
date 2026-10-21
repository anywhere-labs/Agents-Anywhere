package com.agentsanywhere.app.ui.screens.announcements

import android.os.SystemClock
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.AnnouncementsApi
import com.agentsanywhere.app.api.PublicAnnouncement
import com.agentsanywhere.app.api.normalizeServerOrigin
import com.agentsanywhere.app.feature.announcements.AnnouncementReadStore
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.sessiondetail.AgentMarkdownText
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal enum class AnnouncementPage { Login, App }

@Composable
internal fun AnnouncementGate(
    api: AnnouncementsApi,
    serverUrl: String,
    page: AnnouncementPage?,
    appVisible: Boolean,
    blocked: Boolean,
) {
    val context = LocalContext.current
    val origin = normalizeServerOrigin(serverUrl).orEmpty()
    val readStore = remember(context) { AnnouncementReadStore(context) }
    var announcement by remember(origin, page) { mutableStateOf<PublicAnnouncement?>(null) }
    var lastCheck by remember(origin, page) { mutableStateOf<Long?>(null) }

    // Match Web: check on entry and foreground, with no periodic/background polling.
    LaunchedEffect(api, origin, page, appVisible) {
        if (origin.isBlank() || page == null || !appVisible) return@LaunchedEffect
        val now = SystemClock.elapsedRealtime()
        if (lastCheck?.let { now - it < 60_000L } == true) return@LaunchedEffect
        lastCheck = now
        try {
            val current = withContext(Dispatchers.IO) { api.current(origin) }
            announcement = current?.takeIf { readStore.isUnread(origin, it) }
        } catch (error: CancellationException) {
            lastCheck = null
            throw error
        } catch (_: Exception) {
            // Optional announcements must never block login or normal app use.
        }
    }

    val pending = announcement ?: return
    if (page == null || !appVisible || blocked) return
    AnnouncementDialog(
        announcement = pending,
        onDismiss = {
            readStore.markRead(origin, pending)
            announcement = null
        },
    )
}

@Composable
private fun AnnouncementDialog(
    announcement: PublicAnnouncement,
    onDismiss: () -> Unit,
) {
    val colors = LocalAAColors.current
    val configuration = LocalConfiguration.current
    val locale = configuration.locales[0]
    val publishedAt = remember(announcement.publishedAt, locale) {
        DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT, locale)
            .format(Date(announcement.publishedAtMillis))
    }
    val shape = RoundedCornerShape(20.dp)
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Column(
            modifier = Modifier
                .padding(horizontal = 22.dp)
                .widthIn(max = 560.dp)
                .fillMaxWidth()
                .heightIn(max = configuration.screenHeightDp.dp * 0.85f)
                .clip(shape)
                .background(colors.dialogSurface)
                .border(1.dp, colors.border, shape)
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    text = stringResource(R.string.announcement_title),
                    color = colors.ink,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = stringResource(R.string.announcement_published_at, publishedAt),
                    color = colors.muted,
                    fontSize = 13.sp,
                )
            }
            Box(
                modifier = Modifier
                    .weight(1f, fill = false)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
            ) {
                AgentMarkdownText(text = announcement.markdown, darkMode = colors.isDark)
            }
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                Button(
                    onClick = onDismiss,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = colors.primaryAction,
                        contentColor = colors.onPrimaryAction,
                    ),
                ) {
                    Text(stringResource(R.string.announcement_acknowledge))
                }
            }
        }
    }
}
