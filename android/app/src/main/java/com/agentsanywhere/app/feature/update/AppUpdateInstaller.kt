package com.agentsanywhere.app.feature.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import java.io.File

object AppUpdateInstaller {
    const val ACTION_INSTALL_RESULT = "com.agentsanywhere.app.APP_UPDATE_INSTALL_RESULT"
    const val EXTRA_UPDATE_SESSION_ID = "app_update_session_id"
    internal const val EXTRA_UPDATE_SERVER_ORIGIN = "app_update_server_origin"
    internal const val EXTRA_UPDATE_VERSION_CODE = "app_update_version_code"
    internal const val EXTRA_UPDATE_FILE_PATH = "app_update_file_path"

    fun install(
        context: Context,
        apk: File,
        target: AppUpdateInstallTarget,
        shouldCommit: () -> Boolean = { true },
    ): Int {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
            }
        }
        val sessionId = installer.createSession(params)
        val preferenceStore = AppUpdatePreferenceStore(context)
        try {
            installer.openSession(sessionId).use { session ->
                apk.inputStream().use { input ->
                    session.openWrite("app-update.apk", 0, apk.length()).use { output ->
                        input.copyTo(output)
                        session.fsync(output)
                    }
                }
                val callback = Intent(context, AppUpdateInstallReceiver::class.java)
                    .putExtra(EXTRA_UPDATE_SESSION_ID, sessionId)
                    .putExtra(EXTRA_UPDATE_SERVER_ORIGIN, target.serverOrigin)
                    .putExtra(EXTRA_UPDATE_VERSION_CODE, target.versionCode)
                    .putExtra(EXTRA_UPDATE_FILE_PATH, target.filePath)
                val pendingIntent = PendingIntent.getBroadcast(
                    context,
                    sessionId,
                    callback,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
                )
                check(shouldCommit()) { "The update install request is no longer current." }
                check(
                    preferenceStore.recordInstallStarted(
                        sessionId = sessionId,
                        serverOrigin = target.serverOrigin,
                        versionCode = target.versionCode,
                        filePath = target.filePath,
                    ),
                ) { "The downloaded update is no longer current." }
                check(shouldCommit()) { "The update install request is no longer current." }
                session.commit(pendingIntent.intentSender)
            }
            return sessionId
        } catch (error: Throwable) {
            runCatching { installer.abandonSession(sessionId) }
            preferenceStore.recordInstallResult(
                sessionId = sessionId,
                status = PackageInstaller.STATUS_FAILURE,
                message = error.message,
                serverOrigin = target.serverOrigin,
                versionCode = target.versionCode,
                filePath = target.filePath,
            )
            throw error
        }
    }
}

class AppUpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val platformSessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        val sessionId = if (platformSessionId >= 0) {
            platformSessionId
        } else {
            intent.getIntExtra(AppUpdateInstaller.EXTRA_UPDATE_SESSION_ID, -1)
        }
        val serverOrigin = intent.getStringExtra(AppUpdateInstaller.EXTRA_UPDATE_SERVER_ORIGIN).orEmpty()
        val versionCode = intent.getIntExtra(AppUpdateInstaller.EXTRA_UPDATE_VERSION_CODE, -1)
        val filePath = intent.getStringExtra(AppUpdateInstaller.EXTRA_UPDATE_FILE_PATH).orEmpty()
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirmation = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                confirmation?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (confirmation != null) {
                    runCatching { context.startActivity(confirmation) }
                        .onFailure { error ->
                            publishInstallResult(
                                context = context,
                                sessionId = sessionId,
                                status = PackageInstaller.STATUS_FAILURE,
                                message = error.message ?: "The system installer could not be opened.",
                                serverOrigin = serverOrigin,
                                versionCode = versionCode,
                                filePath = filePath,
                            )
                        }
                } else {
                    publishInstallResult(
                        context = context,
                        sessionId = sessionId,
                        status = PackageInstaller.STATUS_FAILURE,
                        message = "The system installer could not be opened.",
                        serverOrigin = serverOrigin,
                        versionCode = versionCode,
                        filePath = filePath,
                    )
                }
            }
            else -> {
                publishInstallResult(
                    context = context,
                    sessionId = sessionId,
                    status = status,
                    message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE),
                    serverOrigin = serverOrigin,
                    versionCode = versionCode,
                    filePath = filePath,
                )
                if (status == PackageInstaller.STATUS_SUCCESS) {
                    context.packageManager.getLaunchIntentForPackage(context.packageName)
                        ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                        ?.let(context::startActivity)
                }
            }
        }
    }

    private fun publishInstallResult(
        context: Context,
        sessionId: Int,
        status: Int,
        message: String?,
        serverOrigin: String,
        versionCode: Int,
        filePath: String,
    ) {
        AppUpdatePreferenceStore(context).recordInstallResult(
            sessionId = sessionId,
            status = status,
            message = message,
            serverOrigin = serverOrigin,
            versionCode = versionCode,
            filePath = filePath,
        )
        context.sendBroadcast(
            Intent(AppUpdateInstaller.ACTION_INSTALL_RESULT)
                .setPackage(context.packageName)
                .putExtra(AppUpdateInstaller.EXTRA_UPDATE_SESSION_ID, sessionId),
        )
    }
}
