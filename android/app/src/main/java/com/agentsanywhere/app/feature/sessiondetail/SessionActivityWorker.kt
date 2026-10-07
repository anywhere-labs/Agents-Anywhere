package com.agentsanywhere.app.feature.sessiondetail

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.agentsanywhere.app.api.ApiClient
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Doze-resilient fallback for session activity notifications.
 *
 * The live path is the dashboard WebSocket kept by the app process; this
 * periodic worker covers the case where the system (or an OEM battery
 * policy) kills that process while sessions are still running on the
 * connector. Every run lists the visible sessions over HTTP and feeds them
 * through the same [SessionActivityMonitor] transition logic, so waiting
 * questions, completions, interruptions and failures still surface as
 * system notifications without any FCM dependency.
 */
class SessionActivityWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val sessionStore = AuthSessionStore(applicationContext)
        if (!sessionStore.hasAuthSession()) return@withContext Result.success()
        val serverUrl = sessionStore.readServerUrl()
        val token = sessionStore.readAccessToken()
        if (serverUrl.isBlank() || token.isBlank()) return@withContext Result.success()
        val sessionsApi = SessionsApi(ApiClient())
        val sessions = runCatching {
            sessionsApi.listSessions(serverUrl, token, archived = false).sessions
        }.getOrNull() ?: return@withContext Result.retry()
        val monitor = synchronized(monitorLock) {
            monitor ?: SessionActivityMonitor(applicationContext, sessionStore, sessionsApi).also {
                it.onAppHidden()
                monitor = it
            }
        }
        monitor.applySnapshot(sessions)
        Result.success()
    }

    companion object {
        private const val WORK_NAME = "session_activity_poll"
        private val monitorLock = Any()
        private var monitor: SessionActivityMonitor? = null

        /** Interval floor imposed by WorkManager for periodic work. */
        private const val REPEAT_INTERVAL_MINUTES = 15L

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<SessionActivityWorker>(
                REPEAT_INTERVAL_MINUTES, TimeUnit.MINUTES,
            ).build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
        }
    }
}
