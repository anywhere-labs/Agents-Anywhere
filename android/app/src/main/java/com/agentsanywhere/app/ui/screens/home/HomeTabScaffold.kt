package com.agentsanywhere.app.ui.screens.home

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import com.agentsanywhere.app.feature.sessions.SessionsState
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.ui.designsystem.BottomNavigationBar
import com.agentsanywhere.app.ui.designsystem.ScreenScaffold
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.navigation.AppTab
import com.agentsanywhere.app.ui.screens.devices.DevicesScreen
import com.agentsanywhere.app.ui.screens.profile.ProfileScreen
import com.agentsanywhere.app.ui.screens.sessions.SessionsScreen
import kotlinx.coroutines.launch

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun HomeTabsScreen(
    selectedTab: AppTab,
    sessionsState: SessionsState,
    isRefreshingSessions: Boolean,
    onRefreshSessions: () -> Unit,
    onRenameSession: suspend (String, String) -> Result<AgentSession>,
    onSetSessionPinned: suspend (String, Boolean) -> Result<AgentSession>,
    onSetSessionArchived: suspend (String, Boolean) -> Result<AgentSession>,
    onOpenSession: (AgentSession) -> Unit,
    onOpenDevice: (AgentDevice) -> Unit,
    navigate: (AppDestination) -> Unit,
) {
    val tabs = remember { AppTab.entries.toList() }
    val pagerState = rememberPagerState(
        initialPage = selectedTab.ordinal,
        pageCount = { tabs.size },
    )
    val latestSelectedTab by rememberUpdatedState(selectedTab)
    val latestNavigate by rememberUpdatedState(navigate)
    val coroutineScope = rememberCoroutineScope()
    var pagerUserScrollEnabled by remember { mutableStateOf(true) }

    LaunchedEffect(selectedTab) {
        if (pagerState.currentPage != selectedTab.ordinal) {
            pagerState.animateScrollToPage(selectedTab.ordinal)
        }
    }

    LaunchedEffect(pagerState) {
        var ignoreInitialEmission = true
        snapshotFlow { pagerState.settledPage }.collect { page ->
            if (ignoreInitialEmission) {
                ignoreInitialEmission = false
                return@collect
            }
            val tab = tabs.getOrNull(page) ?: return@collect
            if (tab != latestSelectedTab) {
                latestNavigate(tab.destination)
            }
        }
    }

    ScreenScaffold(
        bottomBar = {
            val visualTab = tabs.getOrNull(pagerState.targetPage) ?: selectedTab
            BottomNavigationBar(
                selected = visualTab,
                navigate = { destination ->
                    val tab = tabs.firstOrNull { it.destination == destination }
                    if (tab == null) {
                        navigate(destination)
                    } else if (tab.ordinal != pagerState.currentPage) {
                        coroutineScope.launch {
                            pagerState.animateScrollToPage(tab.ordinal)
                        }
                    }
                },
            )
        },
    ) {
        HorizontalPager(
            state = pagerState,
            modifier = androidx.compose.ui.Modifier
                .weight(1f)
                .fillMaxWidth(),
            beyondViewportPageCount = tabs.lastIndex,
            userScrollEnabled = pagerUserScrollEnabled,
        ) { page ->
            when (tabs[page]) {
                AppTab.Sessions -> SessionsScreen(
                    navigate = navigate,
                    state = sessionsState,
                    isRefreshing = isRefreshingSessions,
                    onRefresh = onRefreshSessions,
                    onRenameSession = onRenameSession,
                    onSetSessionPinned = onSetSessionPinned,
                    onSetSessionArchived = onSetSessionArchived,
                    onOpenSession = onOpenSession,
                    onFilterGestureActiveChange = { active ->
                        pagerUserScrollEnabled = !active
                    },
                )
                AppTab.Devices -> DevicesScreen(
                    state = sessionsState,
                    isRefreshing = isRefreshingSessions,
                    onRefresh = onRefreshSessions,
                    onOpenDevice = onOpenDevice,
                )
                AppTab.Profile -> ProfileScreen(navigate = navigate)
            }
        }
    }
}
