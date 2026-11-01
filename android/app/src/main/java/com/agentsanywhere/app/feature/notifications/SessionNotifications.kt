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

object SessionNotifications {
    private const val PREFS = "session_notification_settings"
    private const val WORK = "session_notification_poll"
    internal const val CHANNEL = "session_activity"

    fun isEnabled(context: Context): Boolean = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", false)

    fun setEnabled(context: Context, enabled: Boolean) {
        val app = context.applicationContext
        app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("enabled", enabled).apply()
        val manager = WorkManager.getInstance(app)
        if (!enabled) {
            manager.cancelUniqueWork(WORK)
            app.getSharedPreferences("session_notification_state", Context.MODE_PRIVATE).edit().clear().apply()
            return
        }
        val request = PeriodicWorkRequestBuilder<SessionNotificationWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        manager.enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.UPDATE, request)
    }
}

class SessionNotificationWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val context = applicationContext
        if (!SessionNotifications.isEnabled(context)) return Result.success()
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled() ||
            (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)) return Result.success()
        val store = AuthSessionStore(context)
        if (!store.hasAuthSession()) return Result.success()
        val identity = store.readAuthSessionId() ?: return Result.success()
        val refresher = MobileAuthSessionRefresher(store)
        val api = SessionsApi(ApiClient(refreshAccessToken = refresher::refreshAccessToken))
        return try {
            val prefs = context.getSharedPreferences("session_notification_state", Context.MODE_PRIVATE)
            val sameIdentity = prefs.getString("identity", null) == identity
            val previous = if (sameIdentity) JSONObject(prefs.getString("sessions", "{}").orEmpty()) else JSONObject()
            val next = JSONObject()
            val alerts = mutableListOf<Triple<String, String, SessionAlert>>()
            var cursor: String? = null
            var pages = 0
            do {
                val page = api.listSessions(store.readServerUrl(), store.readAccessToken(), archived = false, limit = 100, cursor = cursor)
                for (session in page.sessions) {
                    val current = SessionAlertState(
                        status = session.status,
                        itemSeq = session.lastItemOrderSeq ?: -1,
                        unread = session.unread,
                        turnEndSeq = session.latestTurnEndSeq,
                    )
                    val old = previous.optJSONObject(session.id)?.let {
                        SessionAlertState(
                            status = it.optString("status"),
                            itemSeq = it.optInt("seq", -1),
                            unread = it.optBoolean("unread"),
                            turnEndSeq = it.optNullableInt("turnEndSeq") ?: it.optNullableInt("turnSeq"),
                        )
                    }
                    sessionAlert(old, current, !sameIdentity)?.let { alerts.add(Triple(session.id, session.title.orEmpty(), it)) }
                    val sessionJson = JSONObject()
                        .put("status", current.status)
                        .put("seq", current.itemSeq)
                        .put("unread", current.unread)
                    current.turnEndSeq?.let { sessionJson.put("turnEndSeq", it) }
                    next.put(session.id, sessionJson)
                }
                cursor = page.nextCursor.takeIf { page.hasMore }
                pages++
            } while (cursor != null && pages < 20)
            if (store.readAuthSessionId() != identity || !SessionNotifications.isEnabled(context)) return Result.success()
            alerts.forEach { (id, title, alert) -> showAlert(id, title, alert) }
            // Retain entries not seen in a truncated result; a later scan may still see them.
            if (cursor != null) previous.keys().forEach { key -> if (!next.has(key)) next.put(key, previous.get(key)) }
            prefs.edit().putString("identity", identity).putString("sessions", next.toString()).apply()
            Result.success()
        } catch (_: Exception) {
            Result.retry()
        }
    }

    private fun showAlert(sessionId: String, sessionTitle: String, alert: SessionAlert) {
        val context = applicationContext
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(SessionNotifications.CHANNEL,
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
        val notification = NotificationCompat.Builder(context, SessionNotifications.CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(label)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setContentText(sessionTitle.ifBlank { context.getString(R.string.app_name) })
            .setContentIntent(pending).setAutoCancel(true).build()
        manager.notify(sessionId.hashCode(), notification)
    }
}
