package com.agentsanywhere.app.feature.sessiondetail

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import com.agentsanywhere.app.MainActivity
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.RemoteSession
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Watches dashboard session snapshots and posts system notifications while the
 * app is in the background:
 *
 * - A session whose runtime status enters `waiting_approval`/`blocked` (the
 *   server projection of a pending question or approval) raises one
 *   interaction notification per wait. Before posting, the open runtime
 *   notices are probed so the notification can quote the actual question or
 *   approval title and body (preferring `input_request`); a failed or empty
 *   probe falls back to the generic texts without blocking the notification.
 * - A session that leaves an active status (`running`, `stopping`,
 *   `waiting_approval`, `blocked`) for `idle` raises a completion
 *   notification — one per finished turn. Best effort: if the session was
 *   seen in `stopping` during the turn, the turn ended through a user
 *   interrupt and the notification says so. Dashboard snapshots only arrive
 *   on dashboard changes, so a very short-lived `stopping` between two
 *   snapshots can be missed and an interrupted turn may still report as
 *   completed.
 * - A session that enters `error` raises a failure notification.
 *
 * The dashboard snapshot projects each session's runtime status, so these
 * transitions arrive without keeping per-session WebSocket connections open in
 * the background. The tradeoff: notification texts come from the session row
 * and a notice probe, not the full notice card content.
 *
 * Nothing notifies while the app is visible. While visible, a wait is only
 * counted as "seen" if the user has that exact session open; other pending
 * waits notify once the app is hidden. The first snapshot after this monitor
 * starts only records a baseline, so reconnects never replay stale events.
 */
class SessionActivityMonitor(
    private val context: Context,
    private val sessionStore: AuthSessionReader,
    private val sessionsApi: SessionsApi,
) {

    private var appVisible = true
    private var visibleSessionId: String? = null
    private val lastStatuses = HashMap<String, String>()
    private val seenWaitingSessionIds = HashSet<String>()
    private val stoppingSeenSessionIds = HashSet<String>()

    // Own IO scope: the notices probe and notification posts must never touch
    // the main thread, and they outlive the snapshot callback that triggers
    // them.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    init {
        ensureNotificationChannel()
    }

    @Synchronized
    fun onAppVisible() {
        appVisible = true
    }

    @Synchronized
    fun onAppHidden() {
        appVisible = false
    }

    @Synchronized
    fun markSessionVisible(sessionId: String?) {
        visibleSessionId = sessionId
    }

    @Synchronized
    fun applySnapshot(sessions: List<RemoteSession>) {
        val sessionById = sessions.associateBy { it.id }
        sessionById.values.forEach { session ->
            val previous = lastStatuses.put(session.id, session.status)
            if (previous != null) {
                evaluateOutcomeTransition(session, previous, session.status)
            }
            when (session.status) {
                "stopping" -> stoppingSeenSessionIds.add(session.id)
                // A fresh turn invalidates an older interrupt observation.
                "running" -> stoppingSeenSessionIds.remove(session.id)
            }
            if (session.status in WAITING_INPUT_STATUSES) {
                if (session.id !in seenWaitingSessionIds) {
                    when {
                        appVisible && session.id == visibleSessionId ->
                            // The user is looking at this session, so the
                            // pending question is already on screen.
                            seenWaitingSessionIds.add(session.id)
                        !appVisible -> {
                            seenWaitingSessionIds.add(session.id)
                            notifyInteraction(session)
                        }
                    }
                }
            } else {
                seenWaitingSessionIds.remove(session.id)
            }
        }
        lastStatuses.keys.retainAll(sessionById.keys)
    }

    private fun evaluateOutcomeTransition(
        session: RemoteSession,
        previousStatus: String,
        currentStatus: String,
    ) {
        if (previousStatus == currentStatus || appVisible) return
        when (currentStatus) {
            "idle" -> if (previousStatus in ACTIVE_STATUSES) {
                val interrupted = stoppingSeenSessionIds.remove(session.id)
                post(
                    sessionId = session.id,
                    title = context.getString(
                        if (interrupted) R.string.session_notification_interrupted_title
                        else R.string.session_notification_complete_title,
                    ),
                    body = session.title,
                    category = NotificationCompat.CATEGORY_STATUS,
                )
            }
            "error" -> if (previousStatus != "error") {
                stoppingSeenSessionIds.remove(session.id)
                post(
                    sessionId = session.id,
                    title = context.getString(R.string.session_notification_failed_title),
                    body = session.title,
                    category = NotificationCompat.CATEGORY_STATUS,
                )
            }
            else -> Unit
        }
    }

    private fun notifyInteraction(session: RemoteSession) {
        scope.launch {
            val probed = runCatching { probeInteractionNotice(session.id) }.getOrNull()
            post(
                sessionId = session.id,
                title = probed?.title
                    ?: context.getString(R.string.session_notification_question_title),
                body = probed?.message ?: session.title,
                category = NotificationCompat.CATEGORY_REMINDER,
            )
        }
    }

    /**
     * Fetches the session's runtime notices and picks the open interaction to
     * quote in the notification: an `input_request` if present, otherwise any
     * open interaction. Returns null (and the caller falls back to the generic
     * texts) when nothing is open, the API call fails, or the session is
     * signed out. Runs on the monitor's IO dispatcher.
     */
    private fun probeInteractionNotice(sessionId: String): ProbedNotice? {
        val serverUrl = sessionStore.readServerUrl()
        val accessToken = sessionStore.readAccessToken()
        if (serverUrl.isBlank() || accessToken.isBlank()) return null
        val notices = sessionsApi.getSessionRuntimeNotices(
            serverUrl = serverUrl,
            authorizationToken = accessToken,
            sessionId = sessionId,
        ).notices
        val openInteractions = notices.filter {
            it.type == "interaction" && it.status == "open"
        }
        val notice = openInteractions.firstOrNull { it.interactionType == "input_request" }
            ?: openInteractions.firstOrNull()
            ?: return null
        return ProbedNotice(
            title = notice.title.trim().takeIf(String::isNotBlank) ?: return null,
            message = notice.message?.trim()?.takeIf(String::isNotBlank),
        )
    }

    private data class ProbedNotice(
        val title: String,
        val message: String?,
    )

    private fun post(
        sessionId: String,
        title: String,
        body: String?,
        category: String,
    ) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        if (manager.getNotificationChannel(CHANNEL_ID)?.importance == NotificationManager.IMPORTANCE_NONE) {
            return
        }
        val text = body?.takeIf(String::isNotBlank)
            ?: context.getString(R.string.session_notification_fallback_body)
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setCategory(category)
            .setAutoCancel(true)
            .setContentIntent(sessionContentIntent(sessionId))
            .build()
        manager.notify(sessionId.hashCode(), notification)
    }

    private fun sessionContentIntent(sessionId: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            action = ACTION_OPEN_SESSION
            putExtra(EXTRA_SESSION_ID, sessionId)
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags = flags or PendingIntent.FLAG_IMMUTABLE
        }
        return PendingIntent.getActivity(context, sessionId.hashCode(), intent, flags)
    }

    private fun ensureNotificationChannel() {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.session_notification_channel_name),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = context.getString(R.string.session_notification_channel_description)
            setShowBadge(true)
        }
        manager.createNotificationChannel(channel)
    }

    companion object {
        const val CHANNEL_ID = "session_activity"
        const val EXTRA_SESSION_ID = "agents_anywhere.extra.SESSION_ID"
        const val ACTION_OPEN_SESSION = "com.agentsanywhere.app.action.OPEN_SESSION"

        // Runtime statuses that mean a turn or an approval gate is in flight.
        private val ACTIVE_STATUSES = setOf("running", "stopping", "waiting_approval", "blocked")

        // Runtime statuses that mean the agent is blocked on user input.
        private val WAITING_INPUT_STATUSES = setOf("waiting_approval", "blocked")
    }
}
