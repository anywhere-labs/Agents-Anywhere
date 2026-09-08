package com.agentsanywhere.app.ui.screens.home

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessions.ArchivedSessionsState
import com.agentsanywhere.app.feature.sessions.SessionPageAppend
import com.agentsanywhere.app.feature.sessions.groupArchivedSessions
import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.ui.designsystem.AAToastHost
import com.agentsanywhere.app.ui.designsystem.AAToastVisuals
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.composables.icons.lucide.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
fun ArchivedSessionsScreen(
    projects: List<AgentProject>,
    onLoadPage: suspend (String?, String?) -> Result<SessionPageAppend>,
    onRestoreSession: suspend (String) -> Result<AgentSession>,
    onRestoreProject: suspend (String) -> Result<List<AgentSession>>,
    onBack: () -> Unit,
) {
    val colors = LocalAAColors.current
    val scope = rememberCoroutineScope()
    val toastHostState = remember { SnackbarHostState() }
    var projectId by rememberSaveable { mutableStateOf<String?>(null) }
    var filterOpen by remember { mutableStateOf(false) }
    var filterBounds by remember { mutableStateOf(Rect.Zero) }
    var state by remember { mutableStateOf(ArchivedSessionsState()) }
    var requestVersion by remember { mutableStateOf(0L) }
    var restoredIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    var restoringIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    var restoringProjectId by remember { mutableStateOf<String?>(null) }
    val restoreSuccess = stringResource(R.string.archived_restored)
    val restoreFailed = stringResource(R.string.archived_restore_failed)
    val loadFailed = stringResource(R.string.archive_load_failed)
    val timeUnavailable = stringResource(R.string.archived_time_unavailable)
    val formatter = remember { DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(ZoneId.systemDefault()) }
    val mutating = restoringIds.isNotEmpty() || restoringProjectId != null
    val selectedProject = projects.firstOrNull { it.id == projectId }
    val groups = remember(state.sessions, projects) { groupArchivedSessions(state.sessions, projects) }

    suspend fun load(reset: Boolean) {
        if (!reset && (state.loading || state.loadingMore || !state.hasMore)) return
        val filter = projectId
        val cursor = if (reset) null else state.nextCursor ?: return
        val version = if (reset) ++requestVersion else requestVersion
        if (reset) restoredIds = emptySet()
        state = if (reset) ArchivedSessionsState() else state.copy(loadingMore = true, error = null)
        try {
            val result = onLoadPage(filter, cursor)
            if (version != requestVersion || projectId != filter) return
            result.onSuccess { page -> state = state.accept(page, reset, restoredIds) }
                .onFailure { error ->
                    if (error is CancellationException) throw error
                    state = state.copy(loading = false, loadingMore = false, error = error.message ?: loadFailed)
                }
        } catch (error: CancellationException) { throw error }
    }

    LaunchedEffect(projectId) { load(reset = true) }
    LaunchedEffect(projects) {
        if (projectId != null && projects.none { it.id == projectId }) projectId = null
    }
    suspend fun restoreProject(id: String) {
        val result = try {
            onRestoreProject(id)
        } finally { restoringProjectId = null }
        result.onSuccess { restored ->
            restoredIds = restoredIds + restored.map { it.id }
            state = state.copy(sessions = state.sessions.filterNot { it.id in restoredIds })
            toastHostState.showSnackbar(AAToastVisuals(message = restoreSuccess))
        }.onFailure { error ->
            if (error is CancellationException) throw error
            toastHostState.showSnackbar(AAToastVisuals(message = error.message ?: restoreFailed, isError = true))
        }
    }

    suspend fun restoreSession(id: String) {
        val result = try {
            onRestoreSession(id)
        } finally { restoringIds = restoringIds - id }
        result.exceptionOrNull()?.let { if (it is CancellationException) throw it }
        val restored = result.getOrNull()?.takeUnless { it.archived }
        if (restored == null) {
            toastHostState.showSnackbar(AAToastVisuals(message = result.exceptionOrNull()?.message ?: restoreFailed, isError = true))
            return
        }
        restoredIds = restoredIds + id
        state = state.copy(sessions = state.sessions.filterNot { it.id == id })
        toastHostState.showSnackbar(AAToastVisuals(message = restoreSuccess))
    }
    BackHandler(onBack = onBack)

    Scaffold(
        containerColor = colors.canvas,
        contentWindowInsets = WindowInsets(0),
        topBar = { ArchivedPageHeader(onBack = onBack) },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            Column(Modifier.fillMaxSize().navigationBarsPadding().padding(start = 18.dp, end = 18.dp, top = 12.dp)) {
                ArchivedProjectSelector(
                    project = selectedProject,
                    expanded = filterOpen,
                    enabled = !mutating,
                    onClick = { filterOpen = true },
                    modifier = Modifier.onGloballyPositioned { filterBounds = it.boundsInWindow() },
                )
                when {
                    state.loading -> ArchivedStatusPanel(
                        title = stringResource(R.string.archive_loading),
                        loading = true,
                    )
                    state.sessions.isEmpty() && state.error != null -> ArchivedStatusPanel(
                        title = loadFailed,
                        description = stringResource(R.string.archive_retry_hint),
                        icon = Lucide.CircleAlert,
                        actionLabel = stringResource(R.string.archived_retry),
                        onAction = { scope.launch { load(reset = !state.hasMore) } },
                    )
                    state.sessions.isEmpty() && state.hasMore -> ArchivedStatusPanel(
                        title = stringResource(R.string.archive_page_empty),
                        showEmptyIllustration = true,
                        description = stringResource(R.string.archive_more_hint),
                        actionLabel = stringResource(R.string.archived_load_more),
                        actionLoading = state.loadingMore,
                        onAction = { scope.launch { load(false) } },
                    )
                    state.sessions.isEmpty() -> ArchivedStatusPanel(
                        title = stringResource(if (projectId == null) R.string.archived_empty else R.string.archive_project_empty),
                        showEmptyIllustration = true,
                    )
                    else -> key(projectId) {
                        LazyColumn(
                            modifier = Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(top = 4.dp, bottom = 24.dp),
                        ) {
                            groups.forEach { group ->
                                item("group:${group.projectId}", contentType = "project") {
                                    ArchivedProjectHeader(
                                        project = group.project,
                                        restoring = restoringProjectId != null && restoringProjectId == group.projectId,
                                        enabled = !mutating,
                                        onRestore = {
                                            group.project?.let { project ->
                                                restoringProjectId = project.id
                                                scope.launch { restoreProject(project.id) }
                                            }
                                        },
                                    )
                                }
                                itemsIndexed(group.sessions, key = { _, session -> "session:${session.id}" }, contentType = { _, _ -> "session" }) { index, session ->
                                    val time = remember(session.archivedAt, session.sortKey, formatter, timeUnavailable) {
                                        runCatching { formatter.format(Instant.parse(session.archivedAt ?: session.sortKey)) }.getOrDefault(timeUnavailable)
                                    }
                                    ArchivedSessionRow(
                                        session = session,
                                        archivedTime = time,
                                        first = index == 0,
                                        last = index == group.sessions.lastIndex,
                                        restoring = session.id in restoringIds || (restoringProjectId != null && restoringProjectId == session.projectId),
                                        enabled = !mutating,
                                        onRestore = {
                                            restoringIds = restoringIds + session.id
                                            scope.launch { restoreSession(session.id) }
                                        },
                                    )
                                }
                            }
                            if (state.error != null || state.hasMore) item("more", contentType = "footer") {
                                ArchivedListFooter(
                                    failed = state.error != null,
                                    loading = state.loadingMore,
                                    enabled = !mutating,
                                    onLoadMore = { scope.launch { load(false) } },
                                )
                            }
                        }
                    }
                }
            }
            AAToastHost(
                hostState = toastHostState,
                modifier = Modifier.align(Alignment.TopCenter).padding(top = 8.dp, start = 22.dp, end = 22.dp),
            )
        }
    }
    if (filterOpen && filterBounds != Rect.Zero) ArchivedProjectPicker(
        projects = projects,
        selectedId = projectId,
        anchorBounds = filterBounds,
        onDismiss = { filterOpen = false },
        onSelect = { projectId = it; filterOpen = false },
    )
}
