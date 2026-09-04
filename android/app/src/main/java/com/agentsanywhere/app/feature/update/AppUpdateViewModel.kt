package com.agentsanywhere.app.feature.update

import android.app.Application
import android.content.pm.PackageInstaller
import android.os.SystemClock
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.agentsanywhere.app.api.AndroidAppRelease
import com.agentsanywhere.app.api.AppUpdatesApi
import com.agentsanywhere.app.api.normalizeServerOrigin
import com.agentsanywhere.app.config.AppConfig
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import java.io.File
import java.io.FileOutputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request

data class AppUpdateUiState(
    val initialHealthResolved: Boolean = false,
    val healthChecking: Boolean = false,
    val backendVersion: String? = null,
    val requiredBackendVersion: String? = null,
    val forcedUpdateRequired: Boolean = false,
    val requiredUpdateUnavailable: Boolean = false,
    val checking: Boolean = false,
    val checked: Boolean = false,
    val release: AndroidAppRelease? = null,
    val promptVisible: Boolean = false,
    val downloading: Boolean = false,
    val downloadedBytes: Long = 0,
    val totalBytes: Long? = null,
    val preparingInstall: Boolean = false,
    val installing: Boolean = false,
    val installFailed: Boolean = false,
    val installFailureMessage: String? = null,
    val installRequestId: Long = 0,
    val downloadFailed: Boolean = false,
    val checkFailed: Boolean = false,
    val installFile: File? = null,
)

enum class AppUpdateCheckSource {
    Automatic,
    Settings,
    Forced,
}

data class AppUpdateInstallTarget(
    val serverOrigin: String,
    val versionCode: Int,
    val filePath: String,
)

internal fun effectiveUpdateServerOrigin(savedServerUrl: String): String {
    return normalizeServerOrigin(savedServerUrl)
        ?: normalizeServerOrigin(AppConfig.OFFICIAL_WEB_LOGIN_URL)
        .orEmpty()
}

class AppUpdateViewModel(application: Application) : AndroidViewModel(application) {
    private val api = AppUpdatesApi()
    private val downloadClient = OkHttpClient()
    private val sessionStore = AuthSessionStore(application)
    private val preferenceStore = AppUpdatePreferenceStore(application)
    private var downloadJob: Job? = null
    private var checkJob: Job? = null
    private var installLaunchJob: Job? = null
    private var releaseServerOrigin: String? = null
    private var requiredVersionServerOrigin: String? = null
    @Volatile
    private var activeInstallLaunchRequestId: Long? = null
    private var activeInstallSessionId: Int? = null
    private var activeOrigin = effectiveUpdateServerOrigin(sessionStore.readServerUrl())
    private var originGeneration = 0L
    private var pipelineGeneration = 0L
    private var updateCheckGeneration = 0L
    private var installRequestGeneration = 0L
    private val automaticUpdateCheckDeadline =
        SystemClock.elapsedRealtime() + AUTOMATIC_UPDATE_CHECK_DELAY_MILLIS
    @Volatile
    private var activeDownloadCall: Call? = null
    @Suppress("DEPRECATION")
    private val packageInfo = application.packageManager.getPackageInfo(application.packageName, 0)
    @Suppress("DEPRECATION")
    private val currentVersionCode = packageInfo.versionCode
    private val currentVersionName = packageInfo.versionName.orEmpty()

    var state by mutableStateOf(AppUpdateUiState())
        private set

    init {
        loadOriginState(activeOrigin)
    }

    suspend fun runForegroundUpdatePipeline(observedServerUrl: String) {
        val serverOrigin = effectiveUpdateServerOrigin(observedServerUrl)
        val pipeline = beginPipeline(serverOrigin)
        if (serverOrigin.isBlank()) {
            if (isCurrentPipeline(pipeline)) {
                state = state.copy(
                    initialHealthResolved = true,
                    healthChecking = false,
                    backendVersion = null,
                    requiredBackendVersion = null,
                    forcedUpdateRequired = false,
                    requiredUpdateUnavailable = false,
                )
            }
            return
        }

        if (!checkBackendCompatibility(pipeline)) return
        val remainingDelay = automaticUpdateCheckDeadline - SystemClock.elapsedRealtime()
        if (remainingDelay > 0) delay(remainingDelay)
        if (!isCurrentPipeline(pipeline)) return
        performUpdateCheck(
            source = AppUpdateCheckSource.Automatic,
            originContext = pipeline.originContext,
            requiredPipelineGeneration = pipeline.generation,
        )
    }

    fun checkForUpdate(source: AppUpdateCheckSource) {
        if (state.checking || state.downloading || state.preparingInstall || state.installing) return
        if (!state.initialHealthResolved) return
        if (state.forcedUpdateRequired && source != AppUpdateCheckSource.Forced) return

        val serverOrigin = currentServerOrigin()
        if (serverOrigin != activeOrigin) {
            switchOrigin(serverOrigin)
            return
        }
        if (serverOrigin.isBlank()) {
            state = state.copy(checked = true, checkFailed = true)
            return
        }

        val originContext = currentOriginContext()
        val job = viewModelScope.launch {
            performUpdateCheck(source = source, originContext = originContext)
        }
        checkJob = job
        job.invokeOnCompletion {
            if (checkJob === job) checkJob = null
        }
    }

    fun dismissPrompt() {
        if (state.forcedUpdateRequired || state.downloading || state.preparingInstall || state.installing) return
        val release = state.release
        val serverOrigin = releaseServerOrigin
        if (release != null && serverOrigin != null) {
            preferenceStore.recordDeferred(serverOrigin, release.versionCode)
        }
        state = state.copy(promptVisible = false)
    }

    fun downloadUpdate() {
        val release = state.release ?: return
        val serverOrigin = releaseServerOrigin ?: return
        if (serverOrigin != activeOrigin || currentServerOrigin() != serverOrigin) return
        if (state.downloading || state.preparingInstall || state.installing) return
        if (state.forcedUpdateRequired && !releaseSatisfiesRequiredVersion(release, state.requiredBackendVersion)) {
            discardCurrentRelease(deleteStoredArtifact = true)
            state = state.copy(requiredUpdateUnavailable = true)
            return
        }

        preferenceStore.recordAccepted(serverOrigin, release.versionCode)
        val cachedFile = state.installFile?.takeIf(File::isFile)
        if (cachedFile != null) {
            preferenceStore.recordDownloadedArtifact(serverOrigin, release, cachedFile.absolutePath)
            activeInstallSessionId = null
            state = state.copy(
                preparingInstall = true,
                installing = false,
                installFailed = false,
                installFailureMessage = null,
                downloadFailed = false,
                installRequestId = nextInstallRequestId(),
            )
            return
        }
        if (state.installFile != null) {
            preferenceStore.clearInstallArtifact(serverOrigin, release.versionCode)
        }

        val originContext = currentOriginContext()
        state = state.copy(
            downloading = true,
            downloadedBytes = 0,
            totalBytes = null,
            preparingInstall = false,
            installing = false,
            installFailed = false,
            installFailureMessage = null,
            installFile = null,
            downloadFailed = false,
        )
        val job = viewModelScope.launch {
            try {
                val file = downloadRelease(release, originContext)
                if (!isCurrentOrigin(originContext) || releaseServerOrigin != serverOrigin) {
                    file.delete()
                    return@launch
                }
                preferenceStore.recordDownloadedArtifact(serverOrigin, release, file.absolutePath)
                state = state.copy(
                    downloading = false,
                    preparingInstall = true,
                    installing = false,
                    installFile = file,
                    installRequestId = nextInstallRequestId(),
                )
            } catch (error: Throwable) {
                val cancelled = error is CancellationException || !currentCoroutineContext().isActive
                if (isCurrentOrigin(originContext)) {
                    state = state.copy(
                        downloading = false,
                        downloadedBytes = 0,
                        totalBytes = null,
                        preparingInstall = false,
                        installing = false,
                        downloadFailed = !cancelled,
                    )
                }
            } finally {
                if (downloadJob === currentCoroutineContext()[Job]) downloadJob = null
            }
        }
        downloadJob = job
    }

    fun cancelDownload() {
        activeDownloadCall?.cancel()
        downloadJob?.cancel()
    }

    fun canInstallFile(file: File): Boolean {
        val currentFile = state.installFile ?: return false
        return state.initialHealthResolved &&
            releaseServerOrigin == activeOrigin &&
            currentServerOrigin() == activeOrigin &&
            runCatching { currentFile.canonicalFile == file.canonicalFile }.getOrDefault(false) &&
            file.isFile
    }

    fun startInstall(file: File, installRequestId: Long) {
        if (!state.preparingInstall || activeInstallLaunchRequestId == installRequestId) return
        val installTarget = currentInstallTarget(file, installRequestId) ?: return
        activeInstallLaunchRequestId = installRequestId
        val job = viewModelScope.launch {
            try {
                val sessionId = withContext(Dispatchers.IO) {
                    AppUpdateInstaller.install(
                        context = getApplication(),
                        apk = file,
                        target = installTarget,
                        shouldCommit = {
                            activeInstallLaunchRequestId == installRequestId &&
                                state.installRequestId == installRequestId &&
                                canInstallFile(file)
                        },
                    )
                }
                markInstallStarted(sessionId, file, installRequestId)
            } catch (error: CancellationException) {
                if (matchesCurrentInstallRequest(file, installRequestId)) {
                    reportInstallFailure(
                        message = error.message,
                        file = file,
                        installRequestId = installRequestId,
                    )
                }
                throw error
            } catch (error: Throwable) {
                reportInstallFailure(
                    message = error.message,
                    file = file,
                    installRequestId = installRequestId,
                )
            } finally {
                if (activeInstallLaunchRequestId == installRequestId) {
                    activeInstallLaunchRequestId = null
                }
                if (installLaunchJob === currentCoroutineContext()[Job]) installLaunchJob = null
            }
        }
        installLaunchJob = job
    }

    private fun currentInstallTarget(file: File, installRequestId: Long): AppUpdateInstallTarget? {
        if (!matchesCurrentInstallRequest(file, installRequestId)) return null
        val serverOrigin = releaseServerOrigin ?: return null
        val release = state.release ?: return null
        return AppUpdateInstallTarget(
            serverOrigin = serverOrigin,
            versionCode = release.versionCode,
            filePath = file.absolutePath,
        )
    }

    fun markInstallStarted(sessionId: Int, file: File, installRequestId: Long) {
        val installTarget = currentInstallTarget(file, installRequestId) ?: return
        if (sessionId < 0 || !file.isFile) {
            reportInstallFailure(file = file, installRequestId = installRequestId)
            return
        }
        activeInstallSessionId = sessionId
        preferenceStore.recordInstallStarted(
            sessionId = sessionId,
            serverOrigin = installTarget.serverOrigin,
            versionCode = installTarget.versionCode,
            filePath = installTarget.filePath,
        )
        state = state.copy(
            promptVisible = false,
            preparingInstall = false,
            installing = true,
            installFailed = false,
            installFailureMessage = null,
            downloadFailed = false,
        )
        refreshInstallResult()
    }

    fun reportInstallFailure(
        message: String? = null,
        file: File? = null,
        installRequestId: Long? = null,
    ) {
        if (file != null && !matchesCurrentInstallRequest(file, installRequestId)) return
        val fileAvailable = state.installFile?.isFile == true
        if (!fileAvailable) {
            val serverOrigin = releaseServerOrigin
            val versionCode = state.release?.versionCode
            if (serverOrigin != null && versionCode != null) {
                preferenceStore.clearInstallArtifact(serverOrigin, versionCode)
            }
        }
        state = state.copy(
            downloading = false,
            preparingInstall = false,
            installing = false,
            installFailed = fileAvailable,
            installFailureMessage = message?.trim()?.takeIf(String::isNotBlank),
            promptVisible = state.release != null,
            downloadFailed = !fileAvailable,
            installFile = state.installFile?.takeIf(File::isFile),
        )
    }

    fun refreshInstallResult() {
        val artifact = recoverInterruptedInstall(
            preferenceStore.readInstallArtifact() ?: return,
        )
        val status = artifact.installStatus ?: return
        if (status == PackageInstaller.STATUS_SUCCESS) {
            File(artifact.filePath).delete()
            preferenceStore.clearInstallArtifact(artifact.serverOrigin, artifact.release.versionCode)
            if (artifact.serverOrigin == activeOrigin &&
                state.release?.versionCode == artifact.release.versionCode
            ) {
                activeInstallSessionId = null
                releaseServerOrigin = null
                state = state.copy(
                    release = null,
                    promptVisible = false,
                    preparingInstall = false,
                    installing = false,
                    installFailed = false,
                    installFailureMessage = null,
                    installFile = null,
                )
            }
            return
        }
        if (artifact.serverOrigin != activeOrigin || currentServerOrigin() != activeOrigin) return

        val file = validatedArtifactFile(artifact)
        if (artifact.release.versionCode <= currentVersionCode) {
            preferenceStore.clearInstallArtifact(artifact.serverOrigin, artifact.release.versionCode)
            if (state.release?.versionCode == artifact.release.versionCode &&
                releaseServerOrigin == artifact.serverOrigin
            ) {
                activeInstallSessionId = null
                releaseServerOrigin = null
                state = state.copy(
                    release = null,
                    promptVisible = false,
                    preparingInstall = false,
                    installing = false,
                    installFailed = false,
                    installFailureMessage = null,
                    installFile = null,
                    downloadFailed = false,
                )
            }
            return
        }
        if (state.forcedUpdateRequired &&
            !releaseSatisfiesRequiredVersion(artifact.release, state.requiredBackendVersion)
        ) {
            discardStoredArtifact(artifact.serverOrigin, artifact.release.versionCode)
            discardCurrentRelease(deleteStoredArtifact = false)
            state = state.copy(requiredUpdateUnavailable = true)
            return
        }
        if (file == null) {
            preferenceStore.clearInstallArtifact(artifact.serverOrigin, artifact.release.versionCode)
            activeInstallSessionId = null
            releaseServerOrigin = artifact.serverOrigin
            val deferred = preferenceStore.isDeferred(
                artifact.serverOrigin,
                artifact.release.versionCode,
            )
            state = state.copy(
                release = artifact.release,
                promptVisible = state.forcedUpdateRequired || !deferred,
                downloading = false,
                preparingInstall = false,
                installing = false,
                installFailed = false,
                installFailureMessage = artifact.installStatusMessage,
                installFile = null,
                downloadFailed = true,
            )
            return
        }

        activeInstallSessionId = artifact.sessionId
        releaseServerOrigin = artifact.serverOrigin
        val deferred = preferenceStore.isDeferred(
            artifact.serverOrigin,
            artifact.release.versionCode,
        )
        state = state.copy(
            release = artifact.release,
            promptVisible = state.forcedUpdateRequired || !deferred,
            downloading = false,
            preparingInstall = false,
            installing = false,
            installFailed = true,
            installFailureMessage = artifact.installStatusMessage,
            installFile = file,
            downloadFailed = false,
        )
    }

    private suspend fun checkBackendCompatibility(pipeline: PipelineContext): Boolean {
        if (!isCurrentPipeline(pipeline)) return false
        state = state.copy(healthChecking = true)
        return try {
            val health = withContext(Dispatchers.IO) { api.health(pipeline.originContext.serverOrigin) }
            if (!isCurrentPipeline(pipeline)) return false
            val comparison = compareNumericVersions(health.version, currentVersionName)
            if (comparison == null) {
                applyUnknownCompatibility(pipeline, reportedBackendVersion = health.version)
            } else if (comparison > 0) {
                preferenceStore.recordRequiredBackendVersion(
                    pipeline.originContext.serverOrigin,
                    health.version,
                )
                requiredVersionServerOrigin = pipeline.originContext.serverOrigin
                retainOnlyReleaseMeetingRequiredVersion(
                    serverOrigin = pipeline.originContext.serverOrigin,
                    requiredVersion = health.version,
                )
                state = state.copy(
                    initialHealthResolved = true,
                    healthChecking = false,
                    backendVersion = health.version,
                    requiredBackendVersion = health.version,
                    forcedUpdateRequired = true,
                    requiredUpdateUnavailable = false,
                    checkFailed = false,
                )
                false
            } else {
                preferenceStore.clearRequiredBackendVersion(pipeline.originContext.serverOrigin)
                if (requiredVersionServerOrigin == pipeline.originContext.serverOrigin) {
                    requiredVersionServerOrigin = null
                }
                state = state.copy(
                    initialHealthResolved = true,
                    healthChecking = false,
                    backendVersion = health.version,
                    requiredBackendVersion = null,
                    forcedUpdateRequired = false,
                    requiredUpdateUnavailable = false,
                    promptVisible = state.release?.let { release ->
                        !preferenceStore.isDeferred(
                            pipeline.originContext.serverOrigin,
                            release.versionCode,
                        )
                    } == true,
                )
                true
            }
        } catch (error: CancellationException) {
            if (isCurrentPipeline(pipeline)) state = state.copy(healthChecking = false)
            throw error
        } catch (_: Throwable) {
            if (!isCurrentPipeline(pipeline)) return false
            applyUnknownCompatibility(pipeline, reportedBackendVersion = null)
        }
    }

    private fun applyUnknownCompatibility(
        pipeline: PipelineContext,
        reportedBackendVersion: String?,
    ): Boolean {
        val requiredVersion = activeRequiredVersion(pipeline.originContext.serverOrigin)
        if (requiredVersion != null) {
            retainOnlyReleaseMeetingRequiredVersion(
                serverOrigin = pipeline.originContext.serverOrigin,
                requiredVersion = requiredVersion,
            )
        }
        state = state.copy(
            initialHealthResolved = true,
            healthChecking = false,
            backendVersion = reportedBackendVersion ?: state.backendVersion ?: requiredVersion,
            requiredBackendVersion = requiredVersion,
            forcedUpdateRequired = requiredVersion != null,
            requiredUpdateUnavailable = false,
        )
        return requiredVersion == null
    }

    private suspend fun performUpdateCheck(
        source: AppUpdateCheckSource,
        originContext: OriginContext,
        requiredPipelineGeneration: Long? = null,
    ) {
        if (!isCurrentOrigin(originContext)) return
        if (requiredPipelineGeneration != null && pipelineGeneration != requiredPipelineGeneration) return
        if (state.checking || state.downloading || state.preparingInstall || state.installing) return
        if (state.forcedUpdateRequired && source != AppUpdateCheckSource.Forced) return

        val checkGeneration = ++updateCheckGeneration
        state = state.copy(
            checking = true,
            checked = if (source == AppUpdateCheckSource.Forced) false else state.checked,
            checkFailed = false,
            requiredUpdateUnavailable = false,
        )
        try {
            val release = withContext(Dispatchers.IO) {
                api.check(originContext.serverOrigin, currentVersionCode)
            }?.takeIf { it.versionCode > currentVersionCode }
            if (!isCurrentCheck(originContext, checkGeneration, requiredPipelineGeneration)) return

            val requiredVersion = state.requiredBackendVersion
            val releaseMeetsRequirement = release != null &&
                releaseSatisfiesRequiredVersion(release, requiredVersion)
            val requiredUpdateUnavailable = source == AppUpdateCheckSource.Forced &&
                state.forcedUpdateRequired && !releaseMeetsRequirement
            val availableRelease = if (requiredUpdateUnavailable) null else release
            val sameCachedRelease = availableRelease != null &&
                releaseServerOrigin == originContext.serverOrigin &&
                state.release?.versionCode == availableRelease.versionCode &&
                state.release?.versionName == availableRelease.versionName &&
                state.installFile?.isFile == true

            if (!sameCachedRelease && state.installFile != null) {
                state.installFile?.delete()
                discardStoredArtifact(originContext.serverOrigin, state.release?.versionCode)
            }
            if (availableRelease == null || !sameCachedRelease) {
                activeInstallSessionId = null
            }
            releaseServerOrigin = availableRelease?.let { originContext.serverOrigin }
            val deferred = availableRelease?.let {
                preferenceStore.isDeferred(originContext.serverOrigin, it.versionCode)
            } == true
            state = state.copy(
                checking = false,
                checked = true,
                release = availableRelease,
                promptVisible = source == AppUpdateCheckSource.Automatic &&
                    availableRelease != null && !deferred,
                requiredUpdateUnavailable = requiredUpdateUnavailable,
                downloadFailed = false,
                checkFailed = false,
                installFile = if (sameCachedRelease) state.installFile else null,
                preparingInstall = if (sameCachedRelease) state.preparingInstall else false,
                installing = if (sameCachedRelease) state.installing else false,
                installFailed = if (sameCachedRelease) state.installFailed else false,
                installFailureMessage = if (sameCachedRelease) state.installFailureMessage else null,
            )
        } catch (error: CancellationException) {
            throw error
        } catch (_: Throwable) {
            if (!isCurrentCheck(originContext, checkGeneration, requiredPipelineGeneration)) return
            state = state.copy(
                checking = false,
                checked = true,
                checkFailed = true,
                requiredUpdateUnavailable = false,
            )
        }
    }

    private fun beginPipeline(serverOrigin: String): PipelineContext {
        if (activeOrigin != serverOrigin) {
            switchOrigin(serverOrigin)
        } else {
            state = state.copy(
                initialHealthResolved = serverOrigin.isBlank(),
                healthChecking = false,
            )
        }
        pipelineGeneration += 1
        invalidateUpdateCheck()
        val originContext = currentOriginContext()
        return PipelineContext(originContext = originContext, generation = pipelineGeneration)
    }

    private fun switchOrigin(serverOrigin: String) {
        if (activeOrigin == serverOrigin) return
        pipelineGeneration += 1
        originGeneration += 1
        invalidateUpdateCheck()
        activeDownloadCall?.cancel()
        downloadJob?.cancel()
        downloadJob = null
        installLaunchJob?.cancel()
        installLaunchJob = null
        activeInstallLaunchRequestId = null
        activeOrigin = serverOrigin
        releaseServerOrigin = null
        requiredVersionServerOrigin = null
        activeInstallSessionId = null
        loadOriginState(serverOrigin)
    }

    private fun invalidateUpdateCheck() {
        updateCheckGeneration += 1
        checkJob?.cancel()
        checkJob = null
        if (state.checking) state = state.copy(checking = false)
    }

    private fun loadOriginState(serverOrigin: String) {
        val requiredVersion = activeRequiredVersion(serverOrigin)
        requiredVersionServerOrigin = requiredVersion?.let { serverOrigin }
        var nextState = AppUpdateUiState(
            initialHealthResolved = serverOrigin.isBlank(),
            backendVersion = requiredVersion,
            requiredBackendVersion = requiredVersion,
            forcedUpdateRequired = requiredVersion != null,
        )
        if (serverOrigin.isBlank()) {
            state = nextState
            return
        }

        val storedArtifact = preferenceStore.readInstallArtifact()
        if (storedArtifact != null && storedArtifact.release.versionCode <= currentVersionCode) {
            File(storedArtifact.filePath).delete()
            preferenceStore.clearInstallArtifact(
                storedArtifact.serverOrigin,
                storedArtifact.release.versionCode,
            )
        }
        val artifact = storedArtifact
            ?.takeIf { it.serverOrigin == serverOrigin && it.release.versionCode > currentVersionCode }
            ?.let(::recoverInterruptedInstall)
        if (artifact == null) {
            state = nextState
            return
        }
        val file = validatedArtifactFile(artifact)
        if (file == null || artifact.installStatus == PackageInstaller.STATUS_SUCCESS) {
            file?.delete()
            preferenceStore.clearInstallArtifact(artifact.serverOrigin, artifact.release.versionCode)
            state = nextState
            return
        }
        if (requiredVersion != null &&
            !releaseSatisfiesRequiredVersion(artifact.release, requiredVersion)
        ) {
            discardStoredArtifact(artifact.serverOrigin, artifact.release.versionCode)
            state = nextState
            return
        }

        val installFailed = artifact.installStatus != null || artifact.sessionId == null
        val deferred = preferenceStore.isDeferred(serverOrigin, artifact.release.versionCode)
        releaseServerOrigin = serverOrigin
        activeInstallSessionId = artifact.sessionId
        nextState = nextState.copy(
            release = artifact.release,
            promptVisible = installFailed && (requiredVersion != null || !deferred),
            installing = artifact.sessionId != null && artifact.installStatus == null,
            installFailed = installFailed,
            installFailureMessage = artifact.installStatusMessage,
            installFile = file,
        )
        state = nextState
    }

    private fun retainOnlyReleaseMeetingRequiredVersion(
        serverOrigin: String,
        requiredVersion: String,
    ) {
        val release = state.release
        if (release != null &&
            releaseServerOrigin == serverOrigin &&
            releaseSatisfiesRequiredVersion(release, requiredVersion)
        ) {
            return
        }
        if (release != null || state.installFile != null || state.downloading) {
            discardCurrentRelease(deleteStoredArtifact = true)
        }
    }

    private fun discardCurrentRelease(deleteStoredArtifact: Boolean) {
        val origin = releaseServerOrigin
        val versionCode = state.release?.versionCode
        activeDownloadCall?.cancel()
        downloadJob?.cancel()
        downloadJob = null
        installLaunchJob?.cancel()
        installLaunchJob = null
        activeInstallLaunchRequestId = null
        state.installFile?.delete()
        if (deleteStoredArtifact && origin != null) {
            preferenceStore.clearInstallArtifact(origin, versionCode)
        }
        releaseServerOrigin = null
        activeInstallSessionId = null
        state = state.copy(
            release = null,
            promptVisible = false,
            downloading = false,
            downloadedBytes = 0,
            totalBytes = null,
            preparingInstall = false,
            installing = false,
            installFailed = false,
            installFailureMessage = null,
            installFile = null,
            downloadFailed = false,
        )
    }

    private fun discardStoredArtifact(serverOrigin: String, versionCode: Int?) {
        val artifact = preferenceStore.readInstallArtifact() ?: return
        if (artifact.serverOrigin != serverOrigin) return
        if (versionCode != null && artifact.release.versionCode != versionCode) return
        File(artifact.filePath).delete()
        preferenceStore.clearInstallArtifact(serverOrigin, artifact.release.versionCode)
    }

    private fun validatedArtifactFile(artifact: StoredUpdateArtifact): File? {
        val updatesDirectory = File(getApplication<Application>().cacheDir, UPDATES_DIRECTORY_NAME)
        return runCatching {
            val root = updatesDirectory.canonicalFile
            val file = File(artifact.filePath).canonicalFile
            val insideRoot = file.parentFile == root || file.path.startsWith("${root.path}${File.separator}")
            file.takeIf { insideRoot && it.isFile }
        }.getOrNull()
    }

    private fun recoverInterruptedInstall(artifact: StoredUpdateArtifact): StoredUpdateArtifact {
        val sessionId = artifact.sessionId ?: return artifact
        if (artifact.installStatus != null) return artifact
        val committed = runCatching {
            getApplication<Application>()
                .packageManager
                .packageInstaller
                .getSessionInfo(sessionId)
                ?.isSealed == true
        }.getOrDefault(false)
        if (committed) return artifact

        runCatching {
            getApplication<Application>()
                .packageManager
                .packageInstaller
                .abandonSession(sessionId)
        }
        preferenceStore.recordInstallResult(
            sessionId = sessionId,
            status = PackageInstaller.STATUS_FAILURE,
            message = INTERRUPTED_INSTALL_MESSAGE,
            serverOrigin = artifact.serverOrigin,
            versionCode = artifact.release.versionCode,
            filePath = artifact.filePath,
        )
        return preferenceStore.readInstallArtifact()
            ?.takeIf {
                it.serverOrigin == artifact.serverOrigin &&
                    it.release.versionCode == artifact.release.versionCode &&
                    it.filePath == artifact.filePath
            }
            ?: artifact.copy(
                installStatus = PackageInstaller.STATUS_FAILURE,
                installStatusMessage = INTERRUPTED_INSTALL_MESSAGE,
            )
    }

    private fun activeRequiredVersion(serverOrigin: String): String? {
        if (serverOrigin.isBlank()) return null
        val persisted = preferenceStore.readRequiredBackendVersion(serverOrigin)
        if (persisted != null && (compareNumericVersions(persisted, currentVersionName) ?: 0) > 0) {
            return persisted
        }
        val inMemory = state.requiredBackendVersion
        return inMemory?.takeIf {
            requiredVersionServerOrigin == serverOrigin &&
                (compareNumericVersions(it, currentVersionName) ?: 0) > 0
        }
    }

    private fun releaseSatisfiesRequiredVersion(
        release: AndroidAppRelease,
        requiredVersion: String?,
    ): Boolean {
        if (requiredVersion == null) return true
        return compareNumericVersions(release.versionName, requiredVersion)?.let { it >= 0 } == true
    }

    private fun currentServerOrigin(): String {
        return effectiveUpdateServerOrigin(sessionStore.readServerUrl())
    }

    private fun nextInstallRequestId(): Long {
        installRequestGeneration += 1
        return installRequestGeneration
    }

    private fun matchesCurrentInstallRequest(file: File, installRequestId: Long?): Boolean {
        val currentFile = state.installFile ?: return false
        return (installRequestId == null || installRequestId == state.installRequestId) &&
            releaseServerOrigin == activeOrigin &&
            currentServerOrigin() == activeOrigin &&
            runCatching { currentFile.canonicalFile == file.canonicalFile }.getOrDefault(false)
    }

    private fun currentOriginContext(): OriginContext {
        return OriginContext(serverOrigin = activeOrigin, generation = originGeneration)
    }

    private fun isCurrentOrigin(context: OriginContext): Boolean {
        return context.generation == originGeneration &&
            context.serverOrigin == activeOrigin &&
            currentServerOrigin() == activeOrigin
    }

    private fun isCurrentPipeline(context: PipelineContext): Boolean {
        return context.generation == pipelineGeneration && isCurrentOrigin(context.originContext)
    }

    private fun isCurrentCheck(
        originContext: OriginContext,
        checkGeneration: Long,
        requiredPipelineGeneration: Long?,
    ): Boolean {
        return checkGeneration == updateCheckGeneration &&
            isCurrentOrigin(originContext) &&
            (requiredPipelineGeneration == null || requiredPipelineGeneration == pipelineGeneration)
    }

    private suspend fun downloadRelease(
        release: AndroidAppRelease,
        originContext: OriginContext,
    ): File = withContext(Dispatchers.IO) {
        val updatesDir = File(getApplication<Application>().cacheDir, UPDATES_DIRECTORY_NAME).apply {
            mkdirs()
        }
        val originKey = Integer.toHexString(originContext.serverOrigin.hashCode())
        val target = File(updatesDir, "agents-anywhere-$originKey-${release.versionCode}.apk")
        try {
            val request = Request.Builder().url(release.downloadUrl).get().build()
            val call = downloadClient.newCall(request)
            activeDownloadCall = call
            try {
                call.execute().use { response ->
                    if (!response.isSuccessful) error("Update download failed with status ${response.code}.")
                    val body = response.body ?: error("Update download was empty.")
                    val totalBytes = body.contentLength().takeIf { it > 0 }
                    publishDownloadProgress(originContext, downloadedBytes = 0, totalBytes = totalBytes)
                    FileOutputStream(target).use { output ->
                        body.byteStream().use { input ->
                            val buffer = ByteArray(64 * 1024)
                            var downloadedBytes = 0L
                            var lastPublishedAt = 0L
                            while (true) {
                                currentCoroutineContext().ensureActive()
                                val count = input.read(buffer)
                                if (count < 0) break
                                output.write(buffer, 0, count)
                                downloadedBytes += count
                                val now = System.nanoTime()
                                if (now - lastPublishedAt >= PROGRESS_UPDATE_INTERVAL_NANOS) {
                                    publishDownloadProgress(originContext, downloadedBytes, totalBytes)
                                    lastPublishedAt = now
                                }
                            }
                            publishDownloadProgress(originContext, downloadedBytes, totalBytes)
                        }
                    }
                }
            } finally {
                if (activeDownloadCall === call) activeDownloadCall = null
            }
            target
        } catch (error: Throwable) {
            target.delete()
            throw error
        }
    }

    private suspend fun publishDownloadProgress(
        originContext: OriginContext,
        downloadedBytes: Long,
        totalBytes: Long?,
    ) {
        withContext(Dispatchers.Main.immediate) {
            if (isCurrentOrigin(originContext)) {
                state = state.copy(downloadedBytes = downloadedBytes, totalBytes = totalBytes)
            }
        }
    }

    private data class OriginContext(
        val serverOrigin: String,
        val generation: Long,
    )

    private data class PipelineContext(
        val originContext: OriginContext,
        val generation: Long,
    )

    companion object {
        private const val AUTOMATIC_UPDATE_CHECK_DELAY_MILLIS = 60_000L
        private const val PROGRESS_UPDATE_INTERVAL_NANOS = 100_000_000L
        private const val UPDATES_DIRECTORY_NAME = "app-updates"
        private const val INTERRUPTED_INSTALL_MESSAGE = "The previous install request did not start."
    }
}

private fun compareNumericVersions(left: String, right: String): Int? {
    val leftParts = left.numericVersionParts() ?: return null
    val rightParts = right.numericVersionParts() ?: return null
    val size = maxOf(leftParts.size, rightParts.size)
    repeat(size) { index ->
        val leftPart = leftParts.getOrElse(index) { 0L }
        val rightPart = rightParts.getOrElse(index) { 0L }
        if (leftPart != rightPart) return leftPart.compareTo(rightPart)
    }
    return 0
}

private fun String.numericVersionParts(): List<Long>? {
    val normalized = trim().removePrefix("v").removePrefix("V")
    if (normalized.isBlank()) return null
    val parts = normalized.split('.')
    if (parts.any { it.isBlank() || it.any { character -> !character.isDigit() } }) return null
    return parts.map { it.toLongOrNull() ?: return null }
}
