package com.agentsanywhere.app.ui.screens.home

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessions.ArchivedSessionsState
import com.agentsanywhere.app.feature.sessions.SessionPageAppend
import com.agentsanywhere.app.feature.sessions.groupArchivedSessions
import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.composables.icons.lucide.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ArchivedSessionsScreen(
    projects: List<AgentProject>,
    onLoadPage: suspend (String?, String?) -> Result<SessionPageAppend>,
    onRestoreSession: suspend (String) -> Result<AgentSession>,
    onRestoreProject: suspend (String) -> Result<List<AgentSession>>,
    onOpenSession: (AgentSession) -> Unit,
    onBack: () -> Unit,
) {
    val colors = LocalAAColors.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var projectId by rememberSaveable { mutableStateOf<String?>(null) }
    var filterOpen by remember { mutableStateOf(false) }
    var state by remember { mutableStateOf(ArchivedSessionsState()) }
    var requestVersion by remember { mutableStateOf(0L) }
    var restoredIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    var restoringIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    var restoringProjectId by remember { mutableStateOf<String?>(null) }
    val restoreSuccess = stringResource(R.string.archived_restored)
    val viewNow = stringResource(R.string.archived_view_now)
    val restoreFailed = stringResource(R.string.archived_restore_failed)
    val timeUnavailable = stringResource(R.string.archived_time_unavailable)
    val formatter = remember { DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(ZoneId.systemDefault()) }
    val mutating = restoringIds.isNotEmpty() || restoringProjectId != null

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
                    state = state.copy(loading = false, loadingMore = false, error = error.message ?: restoreFailed)
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
            snackbar.showSnackbar(restoreSuccess)
        }.onFailure { error ->
            if (error is CancellationException) throw error
            snackbar.showSnackbar(error.message ?: restoreFailed)
        }
    }

    suspend fun restoreSession(id: String) {
        val result = try {
            onRestoreSession(id)
        } finally { restoringIds = restoringIds - id }
        result.exceptionOrNull()?.let { if (it is CancellationException) throw it }
        val restored = result.getOrNull()?.takeUnless { it.archived }
        if (restored == null) {
            snackbar.showSnackbar(result.exceptionOrNull()?.message ?: restoreFailed)
            return
        }
        restoredIds = restoredIds + id
        state = state.copy(sessions = state.sessions.filterNot { it.id == id })
        if (snackbar.showSnackbar(restoreSuccess, actionLabel = viewNow) == SnackbarResult.ActionPerformed) {
            onOpenSession(restored)
        }
    }
    BackHandler(onBack = onBack)

    Scaffold(
        containerColor = colors.canvas,
        contentWindowInsets = WindowInsets(0),
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            Row(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.statusBars).padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack) { Icon(Lucide.ChevronLeft, stringResource(R.string.common_back), tint = colors.ink) }
                Text(stringResource(R.string.profile_archived_sessions), Modifier.weight(1f).padding(start = 8.dp), color = colors.ink, style = MaterialTheme.typography.titleMedium)
                IconButton(enabled = !state.loading && !mutating, onClick = { scope.launch { load(true) } }) { Icon(Lucide.RefreshCw, stringResource(R.string.archived_refresh), tint = colors.muted) }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(horizontal = 18.dp)) {
            OutlinedButton(onClick = { filterOpen = true }, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f), horizontalAlignment = Alignment.Start) {
                    val selected = projects.firstOrNull { it.id == projectId }
                    Text(selected?.name ?: stringResource(R.string.archived_all_projects), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    selected?.let { Text(it.workspacePath, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
                Icon(Lucide.ChevronDown, null)
            }
            when {
                state.loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                state.sessions.isEmpty() -> Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Lucide.Archive, null, tint = colors.muted, modifier = Modifier.size(36.dp))
                    Text(state.error ?: stringResource(R.string.archived_empty), color = colors.muted, modifier = Modifier.padding(18.dp))
                    if (state.error != null) TextButton(onClick = { scope.launch { load(true) } }) { Text(stringResource(R.string.archived_retry)) }
                    if (state.hasMore) TextButton(enabled = !state.loadingMore, onClick = { scope.launch { load(false) } }) {
                        Text(stringResource(if (state.loadingMore) R.string.archived_loading_more else R.string.archived_load_more))
                    }
                }
                else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 16.dp, bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    groupArchivedSessions(state.sessions, projects).forEach { group ->
                        item("group:${group.projectId}") {
                            Row(Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                Icon(Lucide.Folder, null, tint = colors.muted, modifier = Modifier.size(20.dp))
                                Column(Modifier.weight(1f).padding(horizontal = 10.dp)) {
                                    Text(group.project?.name ?: stringResource(R.string.archived_unknown_project), color = colors.ink, fontWeight = FontWeight.SemiBold)
                                    group.project?.let { Text(it.workspacePath, style = MaterialTheme.typography.bodySmall, color = colors.muted, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                                    Text(stringResource(R.string.archived_loaded_count, group.sessions.size), color = colors.muted, style = MaterialTheme.typography.labelSmall)
                                }
                                group.project?.let { project ->
                                    TextButton(enabled = !mutating, onClick = {
                                        restoringProjectId = project.id
                                        scope.launch { restoreProject(project.id) }
                                    }) { Text(stringResource(if (restoringProjectId == project.id) R.string.archived_restoring else R.string.archived_restore_project)) }
                                }
                            }
                        }
                        items(group.sessions, key = { "session:${it.id}" }) { session ->
                            Surface(color = colors.raisedSurface, shape = MaterialTheme.shapes.medium) {
                                Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Column(Modifier.weight(1f)) {
                                        Text(session.title, color = colors.ink, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                        val time = runCatching { formatter.format(Instant.parse(session.archivedAt ?: session.sortKey)) }.getOrDefault(timeUnavailable)
                                        Text(time, color = colors.muted, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 5.dp))
                                    }
                                    TextButton(enabled = !mutating, onClick = {
                                        restoringIds = restoringIds + session.id
                                        scope.launch { restoreSession(session.id) }
                                    }) { Text(stringResource(if (session.id in restoringIds) R.string.archived_restoring else R.string.archived_restore)) }
                                }
                            }
                        }
                    }
                    state.error?.let { message -> item("error") { Text(message, color = MaterialTheme.colorScheme.error) } }
                    if (state.hasMore) item("more") {
                        TextButton(enabled = !state.loadingMore, onClick = { scope.launch { load(false) } }, modifier = Modifier.fillMaxWidth()) {
                            Text(stringResource(if (state.loadingMore) R.string.archived_loading_more else R.string.archived_load_more))
                        }
                    }
                }
            }
        }
    }
    if (filterOpen) ModalBottomSheet(onDismissRequest = { filterOpen = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = colors.canvas) {
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 480.dp), contentPadding = PaddingValues(18.dp)) {
            item { TextButton(onClick = { projectId = null; filterOpen = false }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.archived_all_projects)) } }
            items(projects, key = { it.id }) { project ->
                TextButton(onClick = { projectId = project.id; filterOpen = false }, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.weight(1f), horizontalAlignment = Alignment.Start) {
                        Text(project.name)
                        Text(project.workspacePath, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    if (project.id == projectId) Icon(Lucide.Check, stringResource(R.string.workspace_selected))
                }
            }
        }
    }
}
