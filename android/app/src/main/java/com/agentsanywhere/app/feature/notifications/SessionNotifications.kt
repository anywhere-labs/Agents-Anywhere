package com.agentsanywhere.app.feature.notifications

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.agentsanywhere.app.MainActivity
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.ApiClient
import com.agentsanywhere.app.api.RemoteDashboardSnapshot
import com.agentsanywhere.app.api.RemoteSession
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.api.optNullableInt
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import com.agentsanywhere.app.feature.auth.MobileAuthSessionRefresher
import org.json.JSONObject
import java.util.concurrent.TimeUnit

internal data class SessionAlertState(
    val status: String,
    val itemSeq: Int,
    val unread: Boolean,
    val turnEndSeq: Int? = null,
)
internal enum class SessionAlert { Approval, Response, Attention }

internal fun sessionAlert(previous: SessionAlertState?, current: SessionAlertState, baseline: Boolean): SessionAlert? {
    if (current.status == "waiting_approval" && previous?.status != current.status) return SessionAlert.Approval
    if (current.status in setOf("error", "blocked") && previous?.status != current.status && !baseline) return SessionAlert.Attention
    if (!baseline && current.status == "idle" && current.unread) {
        val isNewResponse = when {
            current.turnEndSeq != null -> {
                if (previous == null) {
                    current.turnEndSeq > 0 || current.itemSeq >= 0
                } else if (previous.turnEndSeq != null) {
                    current.turnEndSeq > previous.turnEndSeq
                } else {
                    previous.status != "idle" || !previous.unread || (current.itemSeq >= 0 && current.itemSeq > previous.itemSeq)
                }
            }
            else -> {
                current.itemSeq >= 0 && (previous == null || current.itemSeq > previous.itemSeq)
            }
        }
        if (isNewResponse) return SessionAlert.Response
    }
    return null
}

internal data class SessionAlertInput(val id: String, val title: String?, val state: SessionAlertState)
internal data class SessionAlertNotification(val sessionId: String, val sessionTitle: String, val alert: SessionAlert)

internal fun sessionAlertInputs(sessions: List<RemoteSession>): List<SessionAlertInput> = sessions.map { session ->
    SessionAlertInput(
        id = session.id,
        title = session.title,
        state = SessionAlertState(
            status = session.status,
            itemSeq = session.lastItemOrderSeq ?: -1,
            unread = session.unread,
            turnEndSeq = session.latestTurnEndSeq,
        ),
    )
}

/** Computes alerts against [previous] and returns them together with the next full state map. */
internal fun computeAlertList(
    previous: Map<String, SessionAlertState>,
    inputs: List<SessionAlertInput>,
    baseline: Boolean,
): Pair<List<SessionAlertNotification>, Map<String, SessionAlertState>> {
    val next = previous.toMutableMap()
    val alerts = mutableListOf<SessionAlertNotification>()
    for (input in inputs) {
        val old = if (baseline) null else previous[input.id]
        sessionAlert(old, input.state, baseline)?.let { alert ->
            alerts.add(SessionAlertNotification(input.id, input.title.orEmpty(), alert))
        }
        next[input.id] = input.state
    }
    return alerts to next
}

private fun JSONObject.toSessionAlertState(): SessionAlertState = SessionAlertState(
    status = optString("status"),
    itemSeq = optInt("seq", -1),
    unread = optBoolean("unread"),
    turnEndSeq = optNullableInt("turnEndSeq") ?: optNullableInt("turnSeq"),
)

private fun JSONObject.toSessionAlertStateMap(): Map<String, SessionAlertState> {
    val states = mutableMapOf<String, SessionAlertState>()
    keys().forEach { key -> optJSONObject(key)?.let { states[key] = it.toSessionAlertState() } }
    return states
}

private fun SessionAlertState.toJson(): JSONObject {
    val json = JSONObject().put("status", status).put("seq", itemSeq).put("unread", unread)
    turnEndSeq?.let { json.put("turnEndSeq", it) }
    return json
}

object SessionNotifications {
    private const val PREFS = "session_notification_settings"
    private const val WORK = "session_notification_poll"
    internal const val CHANNEL = "session_activity"
    private const val STATE_PREFS = "session_notification_state"

    // Both the periodic worker and the realtime observer mutate the persisted alert state; keep
    // read-compare-write cycles atomic so a transition is never alerted twice or lost.
    private val stateLock = Any()

    fun isEnabled(context: Context): Boolean = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", false)

    fun setEnabled(context: Context, enabled: Boolean) {
        val app = context.applicationContext
        app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("enabled", enabled).apply()
        val manager = WorkManager.getInstance(app)
        if (!enabled) {
            manager.cancelUniqueWork(WORK)
            app.getSharedPreferences(STATE_PREFS, Context.MODE_PRIVATE).edit().clear().apply()
            return
        }
        val request = PeriodicWorkRequestBuilder<SessionNotificationWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        manager.enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.UPDATE, request)
    }

    private fun readAlertStates(prefs: android.content.SharedPreferences): Map<String, SessionAlertState> =
        prefs.getString("sessions", null)?.let { stored ->
            runCatching { JSONObject(stored) }.getOrNull()?.toSessionAlertStateMap()
        } ?: emptyMap()

    private fun writeAlertStates(prefs: android.content.SharedPreferences, identity: String, states: Map<String, SessionAlertState>) {
        val nextJson = JSONObject()
        states.forEach { (id, state) -> nextJson.put(id, state.toJson()) }
        prefs.edit().putString("identity", identity).putString("sessions", nextJson.toString()).apply()
    }

    /**
     * Compares [inputs] against the persisted alert state and stores the new view. A mismatched
     * stored identity (fresh login, cleared state) turns the pass into a baseline: nothing is
     * alerted, the state is just seeded.
     */
    internal fun consumeAlertInputs(
        context: Context,
        identity: String,
        inputs: List<SessionAlertInput>,
        baseline: Boolean = false,
    ): List<SessionAlertNotification> = synchronized(stateLock) {
        val prefs = context.getSharedPreferences(STATE_PREFS, Context.MODE_PRIVATE)
        val sameIdentity = prefs.getString("identity", null) == identity
        val effectiveBaseline = baseline || !sameIdentity
        val previous = if (sameIdentity) readAlertStates(prefs) else emptyMap()
        val (alerts, next) = computeAlertList(previous, inputs, effectiveBaseline)
        writeAlertStates(prefs, identity, next)
        alerts
    }

    /** Stores the current view without alerting; skips the write when nothing changed. */
    internal fun recordAlertInputs(context: Context, identity: String, inputs: List<SessionAlertInput>) {
        synchronized(stateLock) {
            val prefs = context.getSharedPreferences(STATE_PREFS, Context.MODE_PRIVATE)
            val sameIdentity = prefs.getString("identity", null) == identity
            val previous = if (sameIdentity) readAlertStates(prefs) else emptyMap()
            if (sameIdentity && inputs.all { previous[it.id] == it.state }) return
            val next = previous.toMutableMap()
            inputs.forEach { next[it.id] = it.state }
            writeAlertStates(prefs, identity, next)
        }
    }

    internal fun canPostNotifications(context: Context): Boolean =
        NotificationManagerCompat.from(context).areNotificationsEnabled() &&
            (Build.VERSION.SDK_INT < 33 ||
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)

    internal fun showAlert(context: Context, sessionId: String, sessionTitle: String, alert: SessionAlert) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL,
            context.getString(R.string.notification_check_channel), NotificationManager.IMPORTANCE_DEFAULT))
        val label = context.getString(when (alert) {
            SessionAlert.Approval -> R.string.notification_waiting
            SessionAlert.Response -> R.string.notification_finished
            SessionAlert.Attention -> R.string.notification_error
        })
        val intent = Intent(context, MainActivity::class.java)
            .putExtra("notification_session_id", sessionId)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pending = PendingIntent.getActivity(context, sessionId.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(label)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setContentText(sessionTitle.ifBlank { context.getString(R.string.app_name) })
            .setContentIntent(pending).setAutoCancel(true).build()
        manager.notify(sessionId.hashCode(), notification)
    }

    /**
     * Keeps the persisted alert state fresh from a foreground dashboard snapshot without
     * alerting, so the background observer compares against current data instead of the last
     * worker poll.
     */
    fun recordDashboardSnapshot(context: Context, store: AuthSessionStore, snapshot: RemoteDashboardSnapshot) {
        if (!isEnabled(context)) return
        val identity = store.readAuthSessionId() ?: return
        recordAlertInputs(context, identity, sessionAlertInputs(snapshot.sessions.filter { !it.archived }))
    }

    /**
     * Consumes a dashboard snapshot while the app is backgrounded: transitions since the last
     * recorded view are alerted immediately instead of waiting for the periodic poll.
     */
    fun handleDashboardSnapshot(context: Context, store: AuthSessionStore, snapshot: RemoteDashboardSnapshot) {
        if (!isEnabled(context)) return
        if (!canPostNotifications(context)) return
        val identity = store.readAuthSessionId() ?: return
        consumeAlertInputs(context, identity, sessionAlertInputs(snapshot.sessions.filter { !it.archived })).forEach { alert ->
            showAlert(context, alert.sessionId, alert.sessionTitle, alert.alert)
        }
    }
}

class SessionNotificationWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val context = applicationContext
        if (!SessionNotifications.isEnabled(context)) return Result.success()
        if (!SessionNotifications.canPostNotifications(context)) return Result.success()
        val store = AuthSessionStore(context)
        if (!store.hasAuthSession()) return Result.success()
        val identity = store.readAuthSessionId() ?: return Result.success()
        val refresher = MobileAuthSessionRefresher(store)
        val api = SessionsApi(ApiClient(refreshAccessToken = refresher::refreshAccessToken))
        return try {
            val sessions = mutableListOf<RemoteSession>()
            var cursor: String? = null
            var pages = 0
            do {
                val page = api.listSessions(store.readServerUrl(), store.readAccessToken(), archived = false, limit = 100, cursor = cursor)
                sessions += page.sessions
                cursor = page.nextCursor.takeIf { page.hasMore }
                pages++
            } while (cursor != null && pages < 20)
            if (store.readAuthSessionId() != identity || !SessionNotifications.isEnabled(context)) return Result.success()
            SessionNotifications.consumeAlertInputs(context, identity, sessionAlertInputs(sessions)).forEach { alert ->
                SessionNotifications.showAlert(context, alert.sessionId, alert.sessionTitle, alert.alert)
            }
            Result.success()
        } catch (_: Exception) {
            Result.retry()
        }
    }
}
